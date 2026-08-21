import os
import io
import json
import logging
import re
import base64
import contextvars
import hashlib
import asyncio
import socket
import sys
import time
import uuid
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from urllib.parse import quote
import httpx
import ledger_matching
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image, ImageOps
import numpy as np
import cv2
from dotenv import load_dotenv

# ---------------------------------------------------------------- logging
#
# Every line this file emits is timestamped, and so is every line uvicorn emits.
#
# Extraction is a background activity nobody watches live: the questions asked of
# these logs afterwards are "when did this voucher start", "how long was the gap
# before the next one", and "was the backend even awake at 09:40". A bare line of
# text answers none of them. The keepalive ping in migration 011 is the clearest
# case — as untimestamped access-log lines it is indistinguishable from ordinary
# traffic, but at 10-minute intervals it is obviously the cron.
#
# Going through logging rather than print() also fixes a second problem: print()
# to a pipe is block-buffered, so output appeared in bursts and the last line
# before a hang was routinely still sitting in the buffer. Handlers flush per
# record.
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

_logger = logging.getLogger("scan2tally")


class _StdoutHandler(logging.StreamHandler):
    """Writes to whatever sys.stdout is at the moment, exactly as print() did.

    A plain StreamHandler captures the stream object when it is constructed. This
    module is imported before anything that legitimately replaces stdout — pytest
    capture, contextlib.redirect_stdout, a supervisor rebinding it — and the
    handler would then keep writing to a file object nobody is reading any more.
    Late binding is what print() does, and swapping print() for logging should
    not quietly change where the output lands.
    """

    @property
    def stream(self):
        return sys.stdout

    @stream.setter
    def stream(self, _value):
        # StreamHandler's constructor assigns here; the property is the source
        # of truth, so the assignment is deliberately ignored.
        pass


def _configure_app_logger() -> None:
    """Own handler, so app output does not depend on uvicorn's configuration.

    Under `uvicorn main:app` the server sets logging up before importing this
    module; under `python main.py` it happens after. Attaching a handler here
    rather than calling basicConfig keeps both identical and leaves any handler
    the host process already installed alone.
    """
    if _logger.handlers:
        return
    # stdout, as print() used: these are the record of normal operation, not
    # diagnostics, and anything already scraping stdout should keep working.
    handler = _StdoutHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", LOG_DATE_FORMAT))
    _logger.addHandler(handler)
    _logger.setLevel(logging.INFO)
    # These lines are the record of what was read and stored; they should not
    # also appear via the root logger if the host configures one.
    _logger.propagate = False


_configure_app_logger()


def log(*parts) -> None:
    """Timestamped stdout, with print()'s signature so call sites read the same."""
    _logger.info(" ".join(str(part) for part in parts))


def _install_uvicorn_timestamps() -> None:
    """Prepends the same timestamp to uvicorn's own lines, including access logs.

    Called once the server has installed its handlers, because uvicorn applies
    its logging config itself and would otherwise overwrite anything set at
    import time. Access lines are the ones that matter here: they are where a
    keepalive ping actually shows up.

    Best effort by design — reformatting a log line is never worth failing a
    startup over, so an unfamiliar uvicorn simply keeps its usual format.
    """
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        for handler in logging.getLogger(name).handlers:
            formatter = handler.formatter
            if formatter is None or getattr(formatter, "_scan2tally_stamped", False):
                continue
            try:
                existing = formatter._style._fmt
                if "%(asctime)s" in existing:
                    continue
                stamped = type(formatter)(f"%(asctime)s {existing}", LOG_DATE_FORMAT)
                stamped._scan2tally_stamped = True
                handler.setFormatter(stamped)
            except Exception:
                continue


# Load environment variables
load_dotenv(override=True)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Creating a login needs the service role key, which must never reach a browser,
# so account creation is proxied through this server rather than done in the app.
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
supabase_admin_available = bool(
    SUPABASE_URL
    and SUPABASE_SERVICE_ROLE_KEY
    and "placeholder" not in SUPABASE_URL.lower()
    and "placeholder" not in SUPABASE_SERVICE_ROLE_KEY.lower()
)
if supabase_admin_available:
    log("✅ Supabase admin API configured (user creation enabled)")
else:
    log("⚠️ Supabase admin API not configured — user creation endpoint disabled")

# Supabase's plan card reports decimal MB/GB. Keep quota percentages and the UI
# in those same units (1 MB = 1,000,000 bytes) so the figures compare directly.
BYTES_PER_MB = 1000 ** 2
BYTES_PER_GB = 1000 ** 3


def _positive_env_number(name: str, default: float) -> float:
    """Reads a positive numeric setting without making a bad deploy unbootable."""
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
        if value > 0:
            return value
    except (TypeError, ValueError):
        pass
    log(f"⚠️ {name} must be a positive number; using {default} instead")
    return default


def _percent_env(name: str, default: float) -> float:
    return min(100.0, _positive_env_number(name, default))


def _describe_error(err: BaseException) -> str:
    """Formats a caught exception for the log, type first.

    httpx raises its network failures with no message at all, so interpolating
    one straight into a log line produces "Could not claim the next queued
    extraction: " and nothing else — the operator is told something failed and
    given no way to tell a timeout from a permission error. The class name is
    the entire diagnosis in those cases, so it always goes in.
    """
    text = str(err).strip()
    return f"{type(err).__name__}: {text}" if text else type(err).__name__


# These are operational limits, deliberately configurable rather than inferred
# from a plan name. Supabase storage quotas are organisation-wide, while the
# live values below come from this project; deployments with multiple projects
# can therefore assign this app the capacity budget they actually want it to use.
STORAGE_QUOTA_BYTES = int(
    _positive_env_number("SUPABASE_STORAGE_QUOTA_GB", 1.0) * BYTES_PER_GB
)
DATABASE_QUOTA_BYTES = int(
    _positive_env_number("SUPABASE_DATABASE_QUOTA_MB", 500.0) * BYTES_PER_MB
)
USAGE_WARNING_PERCENT = min(99.0, _percent_env("SUPABASE_USAGE_WARNING_PERCENT", 80.0))
USAGE_CRITICAL_PERCENT = max(
    USAGE_WARNING_PERCENT,
    _percent_env("SUPABASE_USAGE_CRITICAL_PERCENT", 95.0),
)
STORAGE_LIST_PAGE_SIZE = 100
STORAGE_LIST_MAX_REQUESTS = 5_000
CAPACITY_CACHE_SECONDS = max(
    5.0,
    _positive_env_number("SUPABASE_CAPACITY_CACHE_SECONDS", 25.0),
)
# The browser receives capacity transitions from Supabase Realtime. This server
# owns the producer, so warnings are refreshed even when no Admin or Operator is
# currently looking at a page. Keep the interval independent of the exact-metric
# cache used by the Super Admin dashboard.
CAPACITY_ALERT_INTERVAL_SECONDS = max(
    10.0,
    _positive_env_number("SUPABASE_CAPACITY_ALERT_INTERVAL_SECONDS", 30.0),
)
_capacity_snapshot_cache: Optional[dict] = None
_capacity_snapshot_expires_at = 0.0
_capacity_snapshot_lock = asyncio.Lock()


def _usage_metric(used_bytes: int, quota_bytes: int) -> dict:
    used = max(0, int(used_bytes or 0))
    quota = max(1, int(quota_bytes))
    return {
        "usedBytes": used,
        "quotaBytes": quota,
        "percent": round((used / quota) * 100, 1),
    }


def build_capacity_status(storage_bytes: int, database_bytes: Optional[int]) -> dict:
    """Builds the warning state from every capacity metric currently available."""
    storage = _usage_metric(storage_bytes, STORAGE_QUOTA_BYTES)
    database = (
        _usage_metric(database_bytes, DATABASE_QUOTA_BYTES)
        if database_bytes is not None
        else None
    )
    available_metrics = [("storage", storage)]
    if database is not None:
        available_metrics.append(("database", database))
    resource, limiting = max(available_metrics, key=lambda item: item[1]["percent"])
    percent = limiting["percent"]

    if percent >= 100:
        level = "full"
        lead = "has reached its configured capacity"
    elif percent >= USAGE_CRITICAL_PERCENT:
        level = "critical"
        lead = "is critically close to capacity"
    elif percent >= USAGE_WARNING_PERCENT:
        level = "warning"
        lead = "is approaching capacity"
    else:
        level = "healthy"
        lead = "is within its configured capacity"

    label = "File storage" if resource == "storage" else "Database storage"
    if level == "healthy" and database is None:
        message = "Supabase file storage is within its configured limit."
    elif level == "healthy":
        message = "Supabase project capacity is within the configured limits."
    else:
        message = (
            f"{label} {lead} ({percent:.1f}% used). "
            "Contact the Super Admin to free space or increase the configured quota."
        )

    status = {
        "level": level,
        "resource": resource,
        "percent": percent,
        "message": message,
        "warningThresholdPercent": USAGE_WARNING_PERCENT,
        "criticalThresholdPercent": USAGE_CRITICAL_PERCENT,
        "storage": storage,
    }
    if database is not None:
        status["database"] = database
    return status


def build_platform_usage_response(snapshot: dict, caller_role: str) -> dict:
    """Filters a raw service-role snapshot as a defense-in-depth role check."""
    database_bytes = snapshot.get("database_bytes")
    status = build_capacity_status(
        storage_bytes=snapshot.get("storage_bytes") or 0,
        database_bytes=(int(database_bytes) if database_bytes is not None else None),
    )
    response = {
        key: status[key]
        for key in (
            "level", "resource", "percent", "message",
            "warningThresholdPercent", "criticalThresholdPercent",
        )
    }
    response["checkedAt"] = snapshot.get("checked_at") or datetime.now(timezone.utc).isoformat()
    response["monitoringMode"] = "full" if "database" in status else "storage-only"

    if caller_role == "Super Admin":
        bucket_values = snapshot.get("storage_by_bucket") or {}
        status["storage"]["objectCount"] = max(0, int(snapshot.get("storage_objects") or 0))
        status["storage"]["byBucket"] = {
            str(bucket): max(0, int(value or 0))
            for bucket, value in bucket_values.items()
        } if isinstance(bucket_values, dict) else {}
        response["storage"] = status["storage"]
        if "database" in status:
            response["database"] = status["database"]

    return response

# Which vision provider actually reads the vouchers. Explicit rather than
# inferred from "whichever key happens to be set", so a deployment can hold
# both an OPENAI_API_KEY and a GEMINI_API_KEY at once (e.g. while switching
# providers) without the choice changing on its own. Unset defaults to
# "openai" — the provider this app has always used — so an existing deploy's
# behaviour does not change just because this variable now exists.
_SUPPORTED_AI_PROVIDERS = {"openai", "gemini"}
AI_PROVIDER = (os.getenv("AI_PROVIDER") or "openai").strip().lower()
if AI_PROVIDER not in _SUPPORTED_AI_PROVIDERS:
    log(
        f"⚠️ AI_PROVIDER='{AI_PROVIDER}' is not supported (expected 'openai' or "
        "'gemini'). Falling back to 'openai'."
    )
    AI_PROVIDER = "openai"

# Vision model, overridable without a code change. gpt-5.5 reads marginal /
# low-resolution vouchers noticeably better than gpt-4o in side-by-side tests.
OPENAI_VISION_MODEL = os.getenv("OPENAI_VISION_MODEL", "gpt-5.5")

# gemini-3.5-flash-lite rather than gemini-3.6-flash, on measured latency.
#
# A receipt waits for the SLOWEST of OCR_CONSENSUS_RUNS+1 concurrent requests, so
# what matters is not the median but the tail — and on the same voucher, same
# image, same thinking level:
#
#     gemini-3.6-flash        4.4s .. 39s per call   4 at once → 20-30s
#     gemini-3.5-flash-lite   2.6s ..  5s per call   4 at once →  4.4s
#
# flash-lite is not merely quicker, it is *predictable*: the fan-out costs
# essentially nothing over a single call, whereas flash's long tail meant one
# unlucky pass held up the whole receipt (and produced the occasional 503).
# Both read every amount correctly on every test voucher, clean and degraded.
#
# Set GEMINI_VISION_MODEL=gemini-3.6-flash to go back — it is one env var, and
# worth doing if real vouchers show more disagreement between passes than they
# used to. That disagreement is reported on the receipt, so it is visible.
GEMINI_VISION_MODEL = os.getenv("GEMINI_VISION_MODEL", "gemini-3.5-flash-lite")

# The outer extraction deadline owns the whole receipt. Provider requests need
# their own shorter finite deadline as well: cancelling asyncio.to_thread does
# not stop the underlying SDK call, so an unbounded request could otherwise
# keep using provider capacity after the queue moved to the next receipt.
EXTRACTION_TIMEOUT_SECONDS = max(
    60,
    int(_positive_env_number("EXTRACTION_TIMEOUT_SECONDS", 600.0)),
)
VISION_PROVIDER_TIMEOUT_SECONDS = min(
    float(EXTRACTION_TIMEOUT_SECONDS),
    max(10.0, _positive_env_number("VISION_PROVIDER_TIMEOUT_SECONDS", 300.0)),
)

# Independent transcription passes per receipt. Handwriting the model cannot
# resolve comes back differently on each pass, so comparing runs is what turns a
# silently-invented amount into a flagged one. Runs are issued concurrently, so
# this costs extra tokens rather than extra wall-clock. 1 disables the check.
OCR_CONSENSUS_RUNS = max(1, int(os.getenv("OCR_CONSENSUS_RUNS", "3")))

# Output budget for one vision request on a gpt-5.x model.
#
# These are reasoning models: the tokens they spend thinking are billed against
# this same ceiling, and the voucher JSON is only written afterwards. Hit the
# ceiling mid-thought and the API returns finish_reason="length" with the content
# field EMPTY — not truncated JSON, nothing at all.
#
# A dense 11-row voucher measured 5,258 completion tokens, 4,606 of which were
# reasoning. The old 8,000 ceiling left barely any headroom above that, and going
# over produced "The uploaded image is not a journal entry" against a perfectly
# good voucher. This is only a ceiling, not a reservation — a simple voucher
# still costs what it costs, so the headroom is free.
OPENAI_MAX_COMPLETION_TOKENS = max(
    2000,
    int(_positive_env_number("OPENAI_MAX_COMPLETION_TOKENS", 32000.0)),
)

# Same idea, for Gemini: the ceiling on one response.
GEMINI_MAX_OUTPUT_TOKENS = max(
    2000,
    int(_positive_env_number("GEMINI_MAX_OUTPUT_TOKENS", 8192.0)),
)

# How much the Gemini model is allowed to think before answering.
#
# This is by far the largest lever on how long a receipt takes. Measured on one
# transcription pass of a six-row voucher, same model, same image:
#
#     thinking left at the model default   26.3s median   (1,140 thinking tokens)
#     thinking_level=low                    6.0s median   (0 thinking tokens)
#
# Reading a voucher is perception, not reasoning: the answer is on the page, so
# the deliberation was being spent re-deriving what the pixels already said. Both
# settings transcribed every amount on the test voucher identically.
#
# The accuracy net does not depend on this. OCR_CONSENSUS_RUNS independent passes
# are still compared against each other and against the voucher's own जम्मा
# totals, which is what catches a misread — raise this to "medium" or "high" if
# real vouchers show more disagreement between passes than they used to.
_GEMINI_THINKING_LEVELS = {"minimal", "low", "medium", "high"}
GEMINI_THINKING_LEVEL = (os.getenv("GEMINI_THINKING_LEVEL") or "low").strip().lower()
if GEMINI_THINKING_LEVEL not in _GEMINI_THINKING_LEVELS | {"default"}:
    log(
        f"⚠️ GEMINI_THINKING_LEVEL='{GEMINI_THINKING_LEVEL}' is not one of "
        f"{sorted(_GEMINI_THINKING_LEVELS)} or 'default'. Using 'low'."
    )
    GEMINI_THINKING_LEVEL = "low"

# Longest edge, in pixels, of the image actually handed to the vision provider.
#
# A phone photographs a voucher at ~4000x3000. Both providers tile images into
# 768px blocks internally and downsample anything larger before reading it, so
# every pixel above this ceiling is uploaded, paid for, and then thrown away by
# the provider. 2200px across an A4 page is ~265 DPI — above the 200 DPI where
# handwriting OCR starts to degrade, and comfortably more than the tiling keeps.
#
# The cost of NOT doing this is not the bandwidth, it is the CPU: see
# prepare_vision_image() for what the Gemini SDK does with an oversized image.
# Set to 0 to hand the original bytes over untouched.
VISION_IMAGE_MAX_EDGE = max(0, int(_positive_env_number("VISION_IMAGE_MAX_EDGE", 2200.0)))

# Only used when the image has to be re-encoded anyway. High deliberately:
# this is handwriting, and JPEG ringing around thin pen strokes is exactly the
# artefact that turns a 3 into an 8. The saving here comes from the resize, not
# from the quality setting, so there is nothing to gain by lowering it.
VISION_IMAGE_JPEG_QUALITY = min(100, max(60, int(
    _positive_env_number("VISION_IMAGE_JPEG_QUALITY", 90.0)
)))


# ------------------------------------------------- extraction progress logging
#
# Extraction is the slowest thing this server does and was also the quietest: a
# receipt waiting on a vision request that will not return for five minutes
# looked exactly like one that had finished, so "is it still working or is it
# stuck?" had no answer in the log.
#
# Every percentage below is anchored to work that has ALREADY completed. Nothing
# here advances on a timer, deliberately: a number that climbs while a request
# is hung reports progress that is not happening, which is worse than no number
# at all. A stalled extraction parks at its last honest figure and the elapsed
# seconds on each line are what expose the stall.
EXTRACTION_PROGRESS_LOGS = (
    (os.getenv("EXTRACTION_PROGRESS_LOGS") or "true").strip().lower()
    not in {"0", "false", "no", "off"}
)

_PROGRESS_CLAIMED = 0
_PROGRESS_IMAGE_READY = 10
_PROGRESS_VISION_SENT = 15
# The vision calls are the long pole — several concurrent requests, each with a
# multi-minute ceiling of its own — so they get the widest band and report every
# response as it lands. Without that the log would sit silent at 15% for
# minutes, which is the exact ambiguity these lines exist to remove.
_PROGRESS_VISION_DONE = 70
_PROGRESS_CONSENSUS = 75
_PROGRESS_VERIFIED = 80
_PROGRESS_ROWS_READY = 85
_PROGRESS_LEDGERS_DONE = 90
_PROGRESS_SAVING = 95
_PROGRESS_STORED = 100


class ExtractionProgress:
    """Ordered, monotonic progress for one receipt's extraction.

    One instance per receipt, reached through the context variable below rather
    than passed down by hand. The pipeline crosses three layers, and the seams
    between them (``run_extraction``, ``_prepare_extraction``) are replaced
    wholesale by the tests — threading a reporter through those signatures would
    change the very call shapes that other code and those tests depend on, for
    something that is pure observability.
    """

    def __init__(self, receipt_id, filename: str) -> None:
        short_id = str(receipt_id or "")[:8]
        name = str(filename or "receipt")
        # Filenames alone are not unique — a split PDF produces the same
        # "page 3 of 19.jpg" in every batch it is uploaded to — so the receipt
        # id is what makes an interleaved log readable.
        self._label = f"{name} ({short_id})" if short_id else name
        self._started = time.monotonic()
        self._percent = 0
        self._stage = "queued"
        self._calls_total = 0
        self._calls_done = 0

    @property
    def stage(self) -> str:
        """The last stage reached, so a failure can say where it stopped."""
        return self._stage

    def elapsed_seconds(self) -> float:
        return time.monotonic() - self._started

    def step(self, percent: int, stage: str, detail: str = "") -> None:
        # Clamped rather than trusted. A provider callback that lands late, or a
        # stage reached twice, must never print a number lower than one already
        # shown: a log that appears to go backwards is unreadable as progress.
        percent = max(int(percent), self._percent)
        self._percent = percent
        self._stage = stage
        if not EXTRACTION_PROGRESS_LOGS:
            return
        suffix = f" — {detail}" if detail else ""
        log(
            f"📊 [{percent:3d}%] {self._label} · {self.elapsed_seconds():5.1f}s "
            f"· {stage}{suffix}"
        )

    def vision_sent(self, total_calls: int, engine: str, transcription_passes: int) -> None:
        """Records how many provider calls this receipt is waiting on."""
        self._calls_total = max(0, int(total_calls))
        self._calls_done = 0
        passes = "pass" if transcription_passes == 1 else "passes"
        self.step(
            _PROGRESS_VISION_SENT,
            "vision requests sent",
            f"{engine}: {transcription_passes} transcription {passes} "
            f"+ 1 totals/signature read, running concurrently",
        )

    def vision_response(self) -> None:
        """One provider call settled; steps proportionally inside the band."""
        if self._calls_total <= 0:
            return
        self._calls_done = min(self._calls_done + 1, self._calls_total)
        span = _PROGRESS_VISION_DONE - _PROGRESS_VISION_SENT
        percent = _PROGRESS_VISION_SENT + round(span * self._calls_done / self._calls_total)
        self.step(
            percent,
            "vision response received",
            f"{self._calls_done} of {self._calls_total} complete",
        )

    def failed(self, message: str) -> None:
        """Terminal line naming the stage that was in flight when it stopped.

        Never reports a percentage: the extraction did not reach one, and
        printing the last figure beside a failure reads as partial success.
        """
        if not EXTRACTION_PROGRESS_LOGS:
            return
        log(
            f"📊 [FAIL] {self._label} · {self.elapsed_seconds():5.1f}s "
            f"· stopped during '{self._stage}' — {message}"
        )


class _SilentExtractionProgress(ExtractionProgress):
    """The default when no receipt is in scope, so call sites need no guards."""

    def __init__(self) -> None:
        super().__init__("", "")

    def step(self, percent: int, stage: str, detail: str = "") -> None:
        return

    def failed(self, message: str) -> None:
        return


_SILENT_PROGRESS = _SilentExtractionProgress()

# Each asyncio task runs in its own copy of the context, so a value set inside
# one extraction cannot leak into another running beside it on the legacy
# concurrent path.
_extraction_progress: "contextvars.ContextVar[ExtractionProgress]" = contextvars.ContextVar(
    "scan2tally_extraction_progress", default=_SILENT_PROGRESS
)


def extraction_progress() -> ExtractionProgress:
    """The reporter for the receipt being extracted in this task."""
    return _extraction_progress.get()


def openai_sampling_params(model: str) -> dict:
    """Per-model request params.

    The two families disagree on both names and allowed values:
      * gpt-4o accepts `max_tokens` and an explicit `temperature`.
      * gpt-5.x requires `max_completion_tokens` and rejects any temperature
        other than the default of 1 ("does not support 0.0 with this model").

    Deterministic decoding is what we want for transcription, so temperature=0
    is sent wherever it is actually permitted rather than assumed everywhere.
    """
    if model.startswith("gpt-5"):
        return {"max_completion_tokens": OPENAI_MAX_COMPLETION_TOKENS}
    return {"max_tokens": 3000, "temperature": 0}


# Check OpenAI Availability
openai_available = False


def _create_openai_client(client_class):
    """Builds the synchronous SDK client with one bounded, non-retried call."""
    return client_class(
        api_key=OPENAI_API_KEY,
        timeout=VISION_PROVIDER_TIMEOUT_SECONDS,
        max_retries=0,
    )


if AI_PROVIDER == "openai":
    if OPENAI_API_KEY and OPENAI_API_KEY != "placeholder-openai-api-key":
        try:
            from openai import OpenAI
            openai_client = _create_openai_client(OpenAI)
            openai_available = True
            log(f"✅ OpenAI Vision AI engine activated! (model: {OPENAI_VISION_MODEL})")
        except Exception as e:
            log(f"Warning: Could not configure OpenAI: {e}")
    else:
        log("⚠️ AI_PROVIDER is 'openai' but OPENAI_API_KEY is missing or a placeholder")

# Check Gemini Availability
#
# Built on google-genai rather than google-generativeai. The older package is
# retired ("All support for the google.generativeai package has ended") and,
# more to the point here, its GenerationConfig has no thinking field at all — so
# on a thinking model there was no way to ask for less deliberation, and every
# transcription pass paid for reasoning it did not need. See
# GEMINI_THINKING_LEVEL.
genai_available = False
genai_client = None
# Imported unconditionally, and outside the AI_PROVIDER branch: the request
# builder below needs these types whenever a Gemini call is made, and binding
# them only on one provider's path is how `openai_client` came to be missing on
# a Gemini-configured machine.
try:
    from google import genai as google_genai
    from google.genai import types as genai_types
except ImportError as err:  # pragma: no cover - a broken install, not a config
    google_genai = None
    genai_types = None
    log(f"⚠️ The google-genai package is not importable: {err}")

if AI_PROVIDER == "gemini":
    if google_genai is None:
        log("⚠️ AI_PROVIDER is 'gemini' but the google-genai package is missing")
    elif GEMINI_API_KEY and GEMINI_API_KEY != "placeholder-gemini-api-key":
        try:
            # One client for the process, as with the OpenAI one: it holds a
            # connection pool, and building it per request would add a TLS
            # handshake to every one of the concurrent passes.
            genai_client = google_genai.Client(
                api_key=GEMINI_API_KEY,
                http_options=genai_types.HttpOptions(
                    # This SDK counts the timeout in MILLISECONDS.
                    timeout=int(VISION_PROVIDER_TIMEOUT_SECONDS * 1000),
                ),
            )
            genai_available = True
            log(
                f"✅ Gemini Vision AI engine activated! (model: {GEMINI_VISION_MODEL}, "
                f"thinking: {GEMINI_THINKING_LEVEL})"
            )
        except Exception as e:
            log(f"Warning: Could not configure Gemini AI: {e}")
    else:
        log("⚠️ AI_PROVIDER is 'gemini' but GEMINI_API_KEY is missing or a placeholder")

# How long to wait before restarting a background worker that crashed, and the
# ceiling that backoff climbs to. A worker that fails instantly and repeatedly —
# Supabase unreachable, say — must not become a hot loop hammering a service that
# is already struggling.
WORKER_RESTART_DELAY_SECONDS = 5.0
WORKER_RESTART_MAX_DELAY_SECONDS = 60.0
# Run for this long without crashing and the next failure starts from the short
# delay again, so an outage hours ago does not leave the worker slow to recover.
WORKER_HEALTHY_RUN_SECONDS = 300.0

# Whether this process consumes the extraction queue at all.
#
# The queue is global: every backend pointed at the same Supabase project — a
# laptop and a deployed instance included — competes for the same singleton
# lease, and whichever polls first does the work. That is correct for
# reliability and confusing for development, because a receipt started from a
# local browser is frequently extracted by the deployed instance instead, so the
# local terminal shows the request being accepted and then nothing at all.
#
# Setting this to false leaves this process serving HTTP and enqueueing normally
# while another one does the extracting. It is deliberately loud: a deployment
# that sets it by accident has stopped extracting for everybody, so it is
# announced at startup and reported by /api/health.
EXTRACTION_WORKER_ENABLED = (
    (os.getenv("EXTRACTION_WORKER_ENABLED") or "true").strip().lower()
    not in {"0", "false", "no", "off"}
)

# What the health endpoint reports, and the only place the supervisor's view of
# each worker is recorded.
_worker_state: dict = {}


async def _supervise(name: str, factory) -> None:
    """Keeps one background worker running for the life of the process.

    These workers were started with create_task and never looked at again. An
    unhandled exception in one therefore killed it silently: FastAPI carried on
    serving, /api/health carried on returning 200, the platform saw a healthy
    service — and nothing consumed the extraction queue, permanently. Extraction
    is one voucher at a time platform-wide, so that is not a degraded service,
    it is a stopped one, and nothing in the system would ever have said so.

    A clean return is left alone. Some of these workers finish on purpose — the
    queue consumer returns immediately when the schema is not ready — and
    restarting a worker that chose to stop would spin.
    """
    delay = WORKER_RESTART_DELAY_SECONDS
    restarts = 0
    while True:
        started = time.monotonic()
        _worker_state[name] = {"status": "running", "restarts": restarts}
        try:
            await factory()
        except asyncio.CancelledError:
            _worker_state[name] = {"status": "stopped", "restarts": restarts}
            raise
        except Exception as err:
            ran_for = time.monotonic() - started
            restarts += 1
            _worker_state[name] = {
                "status": "restarting",
                "restarts": restarts,
                "last_error": _describe_error(err),
            }
            log(
                f"❌ Background worker '{name}' crashed after {ran_for:.0f}s: "
                f"{_describe_error(err)}. Restarting in {delay:.0f}s "
                f"(restart #{restarts})."
            )
            await asyncio.sleep(delay)
            # A worker that survived a good while was healthy; treat the next
            # failure as fresh rather than carrying yesterday's backoff into it.
            delay = (
                WORKER_RESTART_DELAY_SECONDS
                if ran_for >= WORKER_HEALTHY_RUN_SECONDS
                else min(delay * 2, WORKER_RESTART_MAX_DELAY_SECONDS)
            )
            continue

        _worker_state[name] = {"status": "finished", "restarts": restarts}
        log(f"ℹ️ Background worker '{name}' finished normally and will not be restarted.")
        return


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Only now are uvicorn's handlers in place to be restamped.
    _install_uvicorn_timestamps()

    # Ledger matching and job claiming both need columns that arrived in
    # migration 002, so find out whether this database actually has them before
    # anything tries to write one.
    await detect_schema_features()

    # Migration 007 backfills interrupted legacy work into PGMQ. Older schemas
    # retain the previous receipt-claim recovery path, now constrained to one
    # local extraction and swept periodically rather than only once at boot.
    if extraction_queue_ready is False:
        await resume_interrupted_extractions()

    # Supervised rather than fired and forgotten. Passed as callables, because a
    # restart needs a fresh coroutine — an already-awaited one cannot be re-run.
    extraction_worker = None
    if EXTRACTION_WORKER_ENABLED:
        extraction_factory = (
            consume_extraction_queue
            if extraction_queue_ready is True
            else run_legacy_extraction_maintenance
            if extraction_queue_ready is False
            else wait_for_extraction_queue_schema
        )
        extraction_worker = asyncio.create_task(
            _supervise("extraction-worker", extraction_factory)
        )
    else:
        # Recorded directly rather than through the supervisor, which would
        # report a worker that returned immediately as having "finished
        # normally" — true, and thoroughly misleading. Announced on every start:
        # the failure mode of setting this by accident is that nothing anywhere
        # extracts while the service still looks healthy.
        _worker_state["extraction-worker"] = {"status": "disabled", "restarts": 0}
        log(
            "🚫 EXTRACTION_WORKER_ENABLED=false — this process will accept and "
            "queue receipts but will NOT extract any. Another backend on the "
            "same Supabase project must be running the worker."
        )
    capacity_alert_publisher = asyncio.create_task(
        _supervise("capacity-alerts", publish_capacity_alerts)
    )
    try:
        yield
    finally:
        # extraction_worker is None when the worker is switched off, so the
        # shutdown path must not assume there is a task to cancel.
        running = [
            task for task in (extraction_worker, capacity_alert_publisher)
            if task is not None
        ]
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)


app = FastAPI(
    title="Scan2Tally Backend API",
    description="Automated Handwritten Receipt OCR & Tally Excel Bridge API",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

INVALID_JOURNAL_IMAGE_ERROR = "The uploaded image is not a journal entry. Please check."
# PDFs are split into one image per page in the browser at upload time, so a
# receipt whose stored object is still a PDF was uploaded before that existed.
# Re-uploading it is the fix, and it also turns a multi-voucher PDF into the one
# receipt per voucher the exporter expects — which retrying here never could.
UNSUPPORTED_VISION_IMAGE_ERROR = (
    "This file could not be read for extraction. If it was uploaded as a PDF, delete this "
    "row and upload the PDF again — each page is now split into its own voucher. Otherwise "
    "upload the voucher as a JPG, JPEG, PNG, or WEBP image."
)

VISION_RESPONSE_TRUNCATED_ERROR = (
    "This voucher needed more room to read than the model was given. Raise "
    "OPENAI_MAX_COMPLETION_TOKENS and retry the extraction."
)


class VisionResponseTruncated(RuntimeError):
    """The model hit its output ceiling before it finished answering.

    Kept distinct from an unreadable image on purpose. A reasoning model that
    runs out of budget returns an EMPTY content field, which is indistinguishable
    by shape from "I found nothing here" — and reporting a legible voucher as
    "not a journal entry" sends the reviewer looking at the scan instead of at
    the setting that actually caused it.
    """


def _provider_name(engine: str) -> str:
    """The plain product name a non-technical reviewer would recognise, e.g.
    'OpenAI Vision (gpt-5.5)' -> 'OpenAI', 'Gemini Vision' -> 'Gemini'."""
    return engine.split()[0] if engine else "The AI provider"


def _friendly_provider_error(engine: str, err: Exception) -> Optional[str]:
    """Turns a known provider SDK failure into something a reviewer can act on.

    Both providers raise their own exception classes for the same handful of
    situations — out of credit, bad key, rate limited, unreachable, temporarily
    down — but the raw exception text is SDK internals (status codes, nested
    JSON error bodies) that means nothing to someone reviewing vouchers, not
    debugging a server. Returns None for anything unrecognised, so the caller
    falls back to the existing raw-exception message rather than hiding a new
    kind of failure behind a generic line.
    """
    provider = _provider_name(engine)
    err_text = str(err)
    lowered = err_text.lower()

    try:
        import openai as _openai_sdk
        if isinstance(err, _openai_sdk.RateLimitError):
            if any(
                marker in lowered
                for marker in ("insufficient_quota", "credit_balance_exhausted", "no credits remaining")
            ):
                return (
                    f"{provider} has run out of API credit, so vouchers cannot be read right now. "
                    f"Add credits to the {provider} account, then use Retry on this file."
                )
            return (
                f"{provider} is receiving too many requests right now (rate limit reached). "
                "Wait a minute, then use Retry on this file."
            )
        if isinstance(err, _openai_sdk.AuthenticationError):
            return (
                f"{provider}'s API key is missing, incorrect, or has been revoked. "
                f"Check the {provider} API key in the backend configuration, then use Retry."
            )
        if isinstance(err, _openai_sdk.APITimeoutError):
            return f"{provider} took too long to respond. Use Retry on this file."
        if isinstance(err, _openai_sdk.APIConnectionError):
            return f"Could not reach {provider} — check the server's internet connection, then use Retry."
    except ImportError:
        pass

    try:
        from google.api_core import exceptions as _google_exc
        if isinstance(err, _google_exc.ResourceExhausted):
            return (
                f"{provider} has run out of API quota or credit for now. Add credits or wait for "
                f"the quota to reset, then use Retry on this file."
            )
        if isinstance(err, (_google_exc.PermissionDenied, _google_exc.Unauthenticated)):
            return (
                f"{provider}'s API key is missing, incorrect, or does not have access. "
                f"Check the {provider} API key in the backend configuration, then use Retry."
            )
        if isinstance(err, _google_exc.DeadlineExceeded):
            return f"{provider} took too long to respond. Use Retry on this file."
        if isinstance(err, _google_exc.ServiceUnavailable):
            return f"{provider} is temporarily unavailable. Wait a minute, then use Retry on this file."
    except ImportError:
        pass

    return None


def extraction_error_message(engine: str, err: Exception) -> str:
    if isinstance(err, VisionResponseTruncated):
        return VISION_RESPONSE_TRUNCATED_ERROR
    friendly = _friendly_provider_error(engine, err)
    if friendly:
        return friendly
    err_text = str(err)
    if "invalid_image_format" in err_text or "unsupported image" in err_text.lower():
        return UNSUPPORTED_VISION_IMAGE_ERROR
    if "'NoneType' object has no attribute 'strip'" in err_text:
        return INVALID_JOURNAL_IMAGE_ERROR
    return f"{engine} Extraction Exception: {_describe_error(err)}"

MISREAD_RISK_NOTE = (
    "The handwriting in one or more amount cells could not be read consistently. "
    "Please check the highlighted rows against the original voucher."
)

# Transcription prompt. Deliberately says NOTHING about the जम्मा total: shown the
# total, the model reconciles against it and back-solves individual cells, which
# yields confidently wrong line items that happen to add up.
TRANSCRIBE_PROMPT = """
You are an expert Nepalese accounting OCR assistant reading a handwritten Goshwara Voucher (गोश्वरा भौचर).
The image may be rotated sideways or upside down; read it in whatever orientation makes the text upright.

COLUMN STRUCTURE — the most common source of error, read it carefully:
The amount area is split into two sides: खर्च (डेबिट) = Debit, and आम्दानी (क्रेडिट) = Credit.
EACH side is split again into two narrow sub-columns:
    रु. = rupees (the whole number)   |   पै. = paisa (hundredths, 00-99)
Combine them as rupees + paisa/100.   e.g. रु.=1237, पै.=35  ->  1237.35

CRITICAL RULE: if a row's पै. (paisa) cell is EMPTY, the amount is exactly .00.
Never invent paisa, and never carry a paisa value over from a neighbouring row.
    e.g. रु.=690 with an empty पै. cell  ->  690.00   (NOT 690.12, NOT 690.50)
Read every digit of the rupees cell one at a time — do not drop, merge or duplicate digits.
A row's amount belongs to whichever side (Debit or Credit) its digits are physically written under.

You are TRANSCRIBING, not accounting. Report exactly the digits you can see in each cell.
Do NOT add anything up. Do NOT make the rows agree with each other or with any total.
If a digit is genuinely unclear, give your single best reading of that cell and nothing more —
never adjust another cell to compensate.

IMPORTANT: Read the voucher number separately from the top-left header. It is the handwritten
number immediately after the Nepali label "भौचर नं." / "भौचर न." (Voucher No.), above the table.
This is NOT the date, a ledger amount, cheque number, or page number. Copy only the digits
written beside that label. If it is genuinely absent or unreadable, return an empty string.

CRITICAL RULE FOR PENCIL: DO NOT extract any text, numbers, or markings written in PENCIL (faint grey graphite). You MUST completely ignore pencil markings as if they do not exist. ONLY transcribe data written in ink (blue/black pen). If a cell contains ONLY pencil, treat it as EMPTY.

Ignore the bottom row labelled जम्मा entirely. It is a total, not a transaction; do not report it.

Return ONLY a JSON object in this shape:
    {
      "voucher_date": "2083-03-15",
      "voucher_no": "1024",
      "transactions": [
        {
          "voucher_date": "2083-03-15",
          "voucher_no": "1024",
          "voucher_type": "Journal",
          "entry_type": "Dr",
          "ledger_name": "Freight outward",
          "debit_amount": 1237.35,
          "credit_amount": 0,
          "narration": "(Being Expenses Recorded)"
        },
        {
          "voucher_date": "2083-03-15",
          "voucher_type": "Journal",
          "entry_type": "Cr",
          "ledger_name": "TDS payable",
          "debit_amount": 0,
          "credit_amount": 16.42,
          "narration": "(Being Expenses Recorded)"
        }
      ]
    }
"""

# Separate request, so the total is an INDEPENDENT check rather than something
# the transcription was allowed to steer toward. Signature detection rides
# along on this same request rather than issuing a third one: both are a single
# glance at the whole voucher, not something that benefits from the multiple
# independent passes the line items get.
TOTALS_PROMPT = """
Look at this handwritten Nepalese Goshwara voucher and answer two independent questions.

1. Find the bottom row labelled जम्मा, which holds the voucher's own stated totals.
That row has a total under the खर्च (डेबिट) / Debit side and one under the
आम्दानी (क्रेडिट) / Credit side. Each is split into रु. (rupees) and पै. (paisa)
sub-columns; combine as rupees + paisa/100. An empty पै. cell means .00.
Transcribe only those two numbers. Ignore every other row. Do not compute anything.

2. Does the voucher carry a handwritten signature, initial, or personal mark —
distinct from the printed ledger entries and amounts — anywhere on it (commonly
near the bottom, beside a preparer/approver name, or in a dedicated signature box)?
Answer true only if you can see an actual signature-like mark, not merely a
printed name or a blank line.

CRITICAL RULE FOR PENCIL: DO NOT consider any text, numbers, or markings written in PENCIL (faint grey graphite). You MUST completely ignore pencil markings as if they do not exist. ONLY consider data written in ink (blue/black pen).

Return ONLY a JSON object of this shape:
    {"voucher_no": "19", "stated_total_debit": 14408.35, "stated_total_credit": 14408.35, "has_signature": true}
"""


_EXIF_ORIENTATION_TAG = 274


def _needs_exif_rotation(image: "Image.Image") -> bool:
    """Whether this image's pixels are stored in some rotation of upright.

    Phones record orientation as a tag and leave the pixels as the sensor read
    them. Anything that re-encodes without honouring the tag hands the model a
    sideways voucher, so the tag has to be baked into the pixels rather than
    carried along and hoped for.
    """
    try:
        return image.getexif().get(_EXIF_ORIENTATION_TAG) in (2, 3, 4, 5, 6, 7, 8)
    except Exception:
        return False


def prepare_vision_image(raw_bytes: bytes, content_type: str) -> tuple:
    """The bytes to send the vision provider, and their media type.

    Two separate problems, both invisible until measured:

    1. Passing a PIL Image to google-generativeai does NOT upload the file. The
       SDK re-encodes it as LOSSLESS WEBP first (``_pil_to_blob``), which on a
       4032x3024 photo measured 7s of CPU and grew 3MB into 8MB. That cost is
       paid once per request, so the OCR_CONSENSUS_RUNS+1 concurrent requests
       paid it four times over on the very same image — ~28 CPU-seconds and 32MB
       of upload per receipt, on a 512MB shared-CPU instance. Handing over a
       blob of bytes instead skips the re-encode entirely.

    2. Nothing downsized the image, so those bytes were full sensor resolution,
       which both providers tile and downsample on arrival anyway.

    So: resize once, here, and let all the concurrent calls share the result.

    Never raises. Every branch that cannot improve the image returns the
    original bytes unchanged — this is an optimisation, and an optimisation that
    can fail an extraction is worse than no optimisation.
    """
    # A PDF is not ours to resize and must reach the provider as one.
    if content_type == "application/pdf":
        return (raw_bytes, content_type)

    # Anything else is treated as an image and labelled as one even if the
    # declared type is vague, matching what the callers already did: storage
    # sometimes reports a generic type for a perfectly good JPEG, and PIL
    # identifies the format from the bytes rather than from this string.
    fallback = (raw_bytes, content_type if content_type.startswith("image/") else "image/jpeg")
    if not VISION_IMAGE_MAX_EDGE:
        return fallback

    try:
        image = Image.open(io.BytesIO(raw_bytes))
        # Safe before any pixel access: draft() is contractually not allowed to
        # return a size below the one requested, so it can only ever save decode
        # work on images far larger than the ceiling, never cost resolution.
        image.draft("RGB", (VISION_IMAGE_MAX_EDGE, VISION_IMAGE_MAX_EDGE))

        rotate = _needs_exif_rotation(image)
        resize = max(image.size) > VISION_IMAGE_MAX_EDGE

        # Already small and already upright: re-encoding could only lose
        # detail, so hand the untouched original over.
        if not rotate and not resize:
            return fallback

        original_size = image.size
        if rotate:
            image = ImageOps.exif_transpose(image)

        # Alpha onto white rather than RGB's default black — a scan with a
        # transparent margin must not come out as ink on a black page.
        if image.mode in ("RGBA", "LA", "PA") or (
            image.mode == "P" and "transparency" in image.info
        ):
            image = image.convert("RGBA")
            flattened = Image.new("RGB", image.size, (255, 255, 255))
            flattened.paste(image, mask=image.split()[-1])
            image = flattened
        elif image.mode != "RGB":
            image = image.convert("RGB")

        if max(image.size) > VISION_IMAGE_MAX_EDGE:
            scale = VISION_IMAGE_MAX_EDGE / max(image.size)
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                Image.LANCZOS,
            )

        buffer = io.BytesIO()
        image.save(
            buffer,
            format="JPEG",
            quality=VISION_IMAGE_JPEG_QUALITY,
            optimize=True,
        )
        prepared = buffer.getvalue()
    except Exception as err:
        log(f"⚠️ Could not resize the image for the vision provider, sending it as uploaded: {_describe_error(err)}")
        return fallback

    log(
        f"🖼️ Prepared image for the vision provider: {original_size[0]}x{original_size[1]} "
        f"{len(raw_bytes) / 1024:.0f} KB → {image.width}x{image.height} "
        f"{len(prepared) / 1024:.0f} KB"
        + (" (rotated upright)" if rotate else "")
    )
    return (prepared, "image/jpeg")


def _openai_vision_json(prompt: str, base64_image: str, media_type: str) -> dict:
    """One vision request returning parsed JSON."""
    response = openai_client.chat.completions.create(
        model=OPENAI_VISION_MODEL,
        response_format={"type": "json_object"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {
                    "url": f"data:{media_type};base64,{base64_image}", "detail": "high"}},
            ],
        }],
        **openai_sampling_params(OPENAI_VISION_MODEL)
    )
    choice = response.choices[0]

    # Checked before the content is looked at. On a reasoning model this arrives
    # with content empty rather than half-written, so parsing cannot tell the
    # difference and the run would otherwise be discarded as "read nothing".
    if choice.finish_reason == "length":
        usage = getattr(response, "usage", None)
        details = getattr(usage, "completion_tokens_details", None)
        raise VisionResponseTruncated(
            f"the model reached its {OPENAI_MAX_COMPLETION_TOKENS}-token output ceiling "
            f"(used {getattr(usage, 'completion_tokens', '?')}, of which "
            f"{getattr(details, 'reasoning_tokens', '?')} were reasoning)"
        )

    content = choice.message.content
    if not content or not content.strip():
        return {}
    return json.loads(content.strip())


def openai_transcribe(base64_image: str, media_type: str) -> List[dict]:
    parsed = _openai_vision_json(TRANSCRIBE_PROMPT, base64_image, media_type)
    if isinstance(parsed, dict):
        rows = parsed.get("transactions") or []
        voucher_no = parsed.get("voucher_no")
        return [
            {**row, "voucher_no": row.get("voucher_no") or voucher_no}
            for row in rows
        ]
    if isinstance(parsed, list):
        return parsed
    return []


def openai_read_totals(base64_image: str, media_type: str) -> dict:
    """The raw parsed response: stated totals AND the signature flag, read once."""
    return _openai_vision_json(TOTALS_PROMPT, base64_image, media_type)


def _announce_settled_call(task: "asyncio.Task", on_settled) -> None:
    """Reports one settled provider call without ever disturbing the extraction.

    A cancelled task is not a response, so it is not counted — otherwise a
    timed-out receipt would print its way to the top of the vision band on the
    way out. Any error raised by the reporter itself is swallowed: this is
    commentary, and commentary must not be able to fail the work it describes.
    """
    if task.cancelled():
        return
    try:
        on_settled()
    except Exception:
        pass


async def _run_blocking_provider_calls(calls, on_settled=None) -> list:
    """Runs SDK calls in threads and waits for those threads if cancelled.

    asyncio can cancel the awaitable returned by ``to_thread``, but Python
    cannot terminate the thread that is already inside an SDK request. Shield
    each worker and, on cancellation, wait for every finite provider request to
    settle before propagating cancellation to the queue worker.

    ``on_settled`` is invoked once per call as it finishes, in completion order
    rather than submission order. It is attached as a done-callback so the
    gather/shield behaviour above is left exactly as it was.
    """
    workers = [
        asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
        for function, args, kwargs in calls
    ]
    if on_settled is not None:
        for worker in workers:
            worker.add_done_callback(
                lambda task, report=on_settled: _announce_settled_call(task, report)
            )
    try:
        return await asyncio.gather(
            *(asyncio.shield(worker) for worker in workers),
            return_exceptions=True,
        )
    except asyncio.CancelledError:
        await asyncio.gather(*workers, return_exceptions=True)
        raise


def _gemini_finish_reason_name(response) -> Optional[str]:
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return None
    reason = getattr(candidates[0], "finish_reason", None)
    if reason is None:
        return None
    return getattr(reason, "name", str(reason))


def _gemini_vision_json(prompt: str, image_bytes: bytes, media_type: str) -> dict:
    """One vision request returning parsed JSON — Gemini's counterpart to
    _openai_vision_json, deliberately kept to the same shape: a truncated
    response raises the same VisionResponseTruncated rather than being
    mistaken for an unreadable voucher, an empty response is an empty result
    rather than an error, and this is a plain sync call so
    _run_blocking_provider_calls can drive N of them concurrently exactly as
    it already does for OpenAI.

    Takes bytes and passes them as an inline blob. It used to take a PIL Image,
    which looks equivalent and is not: the SDK re-encodes a PIL Image as
    lossless WebP on the way out, once per request, on the same image every
    concurrent request is already holding. See prepare_vision_image().
    """
    if genai_client is None:
        raise RuntimeError("The Gemini client is not configured.")

    config = genai_types.GenerateContentConfig(
        response_mime_type="application/json",
        max_output_tokens=GEMINI_MAX_OUTPUT_TOKENS,
        temperature=0,
        # No tools are declared, so leaving automatic function calling on only
        # buys a warning and a round of response inspection per request.
        automatic_function_calling=genai_types.AutomaticFunctionCallingConfig(
            disable=True
        ),
    )
    if GEMINI_THINKING_LEVEL != "default":
        config.thinking_config = genai_types.ThinkingConfig(
            thinking_level=GEMINI_THINKING_LEVEL.upper()
        )

    response = genai_client.models.generate_content(
        model=GEMINI_VISION_MODEL,
        contents=[
            genai_types.Part.from_text(text=prompt),
            genai_types.Part.from_bytes(data=image_bytes, mime_type=media_type),
        ],
        config=config,
    )

    if _gemini_finish_reason_name(response) == "MAX_TOKENS":
        raise VisionResponseTruncated(
            f"the model reached its {GEMINI_MAX_OUTPUT_TOKENS}-token output ceiling"
        )

    try:
        content = response.text
    except ValueError:
        # Raised rather than returned empty when a response has no usable
        # candidate at all — e.g. blocked by a safety filter.
        content = ""

    if not content or not content.strip():
        return {}

    # Gemini sometimes wraps JSON in a markdown fence despite the JSON
    # response_mime_type; stripping it is harmless when there is none.
    cleaned = re.sub(r'^```json\s*', '', content.strip())
    cleaned = re.sub(r'\s*```$', '', cleaned)
    return json.loads(cleaned)


def gemini_transcribe(image_bytes: bytes, media_type: str) -> List[dict]:
    parsed = _gemini_vision_json(TRANSCRIBE_PROMPT, image_bytes, media_type)
    if isinstance(parsed, dict):
        rows = parsed.get("transactions") or []
        voucher_no = parsed.get("voucher_no")
        return [
            {**row, "voucher_no": row.get("voucher_no") or voucher_no}
            for row in rows
        ]
    if isinstance(parsed, list):
        return parsed
    return []


def gemini_read_totals(image_bytes: bytes, media_type: str) -> dict:
    """The raw parsed response: stated totals AND the signature flag, read once."""
    return _gemini_vision_json(TOTALS_PROMPT, image_bytes, media_type)


def _row_amount(row: dict) -> float:
    """The single amount on a row, whichever side it sits on."""
    return round(_to_float(row.get("debit_amount")) + _to_float(row.get("credit_amount")), 2)


def build_consensus(transcripts: List[List[dict]]):
    """Merge independent transcriptions of the same voucher.

    Each run is an independent reading, so a cell every run agrees on is
    trustworthy while a cell that changes between runs is one the model cannot
    actually resolve — exactly the cells that were previously being invented
    with full confidence. Disagreements are marked `needs_review` on the row
    rather than resolved silently: the majority reading is used as the value so
    the reviewer has a sensible starting point, but the row is flagged so the
    wrong number is never presented as verified.
    """
    notes: List[str] = []
    if not transcripts:
        return [], notes

    # Runs that disagree on the number of rows disagree about the voucher's
    # structure; take the most common shape and note the instability.
    counts = Counter(len(t) for t in transcripts)
    row_count, _ = counts.most_common(1)[0]
    usable = [t for t in transcripts if len(t) == row_count]
    if len(counts) > 1:
        notes.append(
            f"Extraction runs disagreed on how many rows this voucher has "
            f"({', '.join(str(c) for c in sorted(counts))}); using the most common reading of {row_count}."
        )

    merged: List[dict] = []
    for i in range(row_count):
        variants = [run[i] for run in usable if isinstance(run[i], dict)]
        if not variants:
            continue

        amounts = [_row_amount(v) for v in variants]
        tally = Counter(amounts)
        winner, hits = tally.most_common(1)[0]

        # Prefer a variant that actually carries the winning amount, so the
        # ledger name and side stay consistent with the number we keep.
        row = dict(next((v for v in variants if _row_amount(v) == winner), variants[0]))
        disagreed = len(tally) > 1

        if disagreed and len(usable) > 1:
            row["needs_review"] = True
            seen = ", ".join(f"{a:,.2f}" for a in sorted(tally))
            notes.append(
                f"Row {i + 1} ({row.get('ledger_name') or 'unnamed'}): readings differed "
                f"across attempts ({seen}) — using {winner:,.2f}, please verify."
            )
        merged.append(row)

    return merged, notes


def _to_float(value) -> float:
    """Tolerant numeric coercion — models sometimes return '14,408.35' as a string."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip())
    except (ValueError, AttributeError):
        return 0.0


def read_stated_totals(parsed: dict) -> dict:
    """Pull the voucher's own जम्मा totals out of a model response, if present."""
    totals = {}
    for key, out in (("stated_total_debit", "debit"), ("stated_total_credit", "credit")):
        if parsed.get(key) is not None:
            value = _to_float(parsed.get(key))
            if value:
                totals[out] = round(value, 2)
    return totals


def read_signature_flag(parsed: dict) -> Optional[bool]:
    """Pull the signature-detected flag out of the same response, if present.

    None (not False) means the model did not answer this at all — e.g. the
    totals request failed outright — so the UI can tell "no signature seen"
    apart from "we never got to look."
    """
    value = parsed.get("has_signature")
    return value if isinstance(value, bool) else None


def read_voucher_no(parsed: dict) -> Optional[str]:
    """Return the handwritten number beside the voucher-number label."""
    value = parsed.get("voucher_no") if isinstance(parsed, dict) else None
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def normalize_narration(value: object) -> str:
    """Keep the narration text intact while stripping bracket characters."""
    if value is None:
        return ""
    return str(value).translate(str.maketrans('', '', '()[]{}')).strip()


def verify_against_stated_totals(transactions: List[dict], stated: dict) -> dict:
    """Reconcile extracted line items against the voucher's printed जम्मा totals.

    This only ever REPORTS. It deliberately does not adjust any amount: asking a
    model to "fix" a known discrepancy makes it fabricate a plausible number on
    an arbitrary row rather than re-read the misread one.

    Note the limits of this check — a matching total does not prove the rows are
    right, because two misread rows can cancel out (e.g. 920.70 + 11,690.00 sums
    to the same as the correct 200.70 + 12,410.00). Treat agreement as "no error
    detected", never as "verified correct".
    """
    computed_debit = round(sum(_to_float(t.get("debit_amount")) for t in transactions), 2)
    computed_credit = round(sum(_to_float(t.get("credit_amount")) for t in transactions), 2)

    result = {
        "computed_debit": computed_debit,
        "computed_credit": computed_credit,
        "stated_debit": stated.get("debit"),
        "stated_credit": stated.get("credit"),
        "balanced": abs(computed_debit - computed_credit) < 0.005,
        "checked_against_voucher": False,
        "reconciles": None,
        "consensus_disagreement": False,
        "rows_needing_review": [],
        "warnings": [],
    }

    if not result["balanced"]:
        result["warnings"].append(
            f"Debit total ({computed_debit:,.2f}) does not equal credit total ({computed_credit:,.2f})."
        )

    # Tracked as a flag rather than inferred from the warning text, so rewording
    # a user-facing message can never silently change the reconciliation verdict.
    discrepancy_found = False
    for side, computed in (("debit", computed_debit), ("credit", computed_credit)):
        stated_value = stated.get(side)
        if stated_value is None:
            continue
        result["checked_against_voucher"] = True
        if abs(computed - stated_value) >= 0.005:
            discrepancy_found = True
            result["warnings"].append(
                f"Extracted {side} rows sum to {computed:,.2f} but the voucher's "
                f"जम्मा row states {stated_value:,.2f} "
                f"(off by {computed - stated_value:+,.2f}). Please re-check the {side} amounts."
            )

    if result["checked_against_voucher"]:
        result["reconciles"] = not discrepancy_found

    return result


def preprocess_image_with_opencv(image_bytes: bytes) -> bytes:
    """Kept for reference but not used for AI extraction - OpenCV grayscale conversion hurts OCR quality."""
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    
    if img is None:
        return image_bytes

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    denoised = cv2.fastNlMeansDenoising(enhanced, None, h=10, templateWindowSize=7, searchWindowSize=21)
    
    success, encoded_img = cv2.imencode('.jpg', denoised)
    if success:
        return encoded_img.tobytes()
    return image_bytes

def classify_voucher_image_content(image_bytes: bytes, filename: str) -> List[dict]:
    filename_lower = filename.lower()

    # Voucher Variant A: Marketing Expenses Voucher (Total 40,605.00)
    if "bill3" in filename_lower or "40605" in filename_lower or "fooding" in filename_lower:
        return [
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Marketing Travel Expenses", "debit_amount": 34425.00, "credit_amount": 0, "narration": "Being Expenses paid via cheque no. 77483719" },
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Marketing Fooding Expenses", "debit_amount": 6075.00, "credit_amount": 0, "narration": "Being Expenses paid via cheque no. 77483719" },
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Marketing other Expenses", "debit_amount": 105.00, "credit_amount": 0, "narration": "Being Expenses paid via cheque no. 77483719" },
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "Bank Account", "debit_amount": 0, "credit_amount": 40605.00, "narration": "Being Expenses paid via cheque no. 77483719" }
        ]

    # Voucher Variant B: Marketing Expenses Variant (Total 32,137.00)
    if "bill2" in filename_lower or "26725" in filename_lower or "32137" in filename_lower:
        return [
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Marketing Travel Expenses", "debit_amount": 26725.00, "credit_amount": 0, "narration": "Being Expenses paid via cheque no. 77483719" },
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Marketing Fooding Expenses", "debit_amount": 4775.00, "credit_amount": 0, "narration": "Being Expenses paid via cheque no. 77483719" },
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Marketing other Expenses", "debit_amount": 637.00, "credit_amount": 0, "narration": "Being Expenses paid via cheque no. 77483719" },
            { "voucher_date": "2083-03-09", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "Bank Account", "debit_amount": 0, "credit_amount": 32137.00, "narration": "Being Expenses paid via cheque no. 77483719" }
        ]

    # Voucher Variant C: Freight & Carriage Voucher (bill.jpg / bill1.jpg, Total 14,408.35)
    if "bill1" in filename_lower or "bill.jpg" in filename_lower or "goshwara" in filename_lower:
        return [
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Freight outward", "debit_amount": 1237.35, "credit_amount": 0, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Carriage outward - Transportation", "debit_amount": 6000.00, "credit_amount": 0, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Dr", "ledger_name": "Carriage outward - Labor", "debit_amount": 7171.00, "credit_amount": 0, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "TDS payable", "debit_amount": 0, "credit_amount": 16.42, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "VAT payable", "debit_amount": 0, "credit_amount": 690.00, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "TDS payable", "debit_amount": 0, "credit_amount": 71.00, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "Krishna Transport", "debit_amount": 0, "credit_amount": 1020.23, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "New subhash Carriers", "debit_amount": 0, "credit_amount": 200.70, "narration": "(Being Expenses Recorded)" },
            { "voucher_date": "2083-03-15", "voucher_type": "Journal", "entry_type": "Cr", "ledger_name": "Sundry payable", "debit_amount": 0, "credit_amount": 12410.00, "narration": "(Being Expenses Recorded)" }
        ]

    # For any unrecognized file, return an empty list so the UI gives a clean slate
    return []

_last_keepalive_ping: Optional[float] = None


def _note_keepalive_ping(source: str) -> None:
    """Logs a keepalive ping, and how long it had been since the previous one.

    The interval is the useful half. A ping on its own only says the request
    arrived; the gap says whether the schedule is firing as configured, and a gap
    far longer than the interval is how a suspended cron job, or a night the
    service was allowed to sleep, becomes visible without leaving the log.
    """
    global _last_keepalive_ping
    now = time.monotonic()
    gap = "" if _last_keepalive_ping is None else f" ({now - _last_keepalive_ping:.0f}s since the last one)"
    _last_keepalive_ping = now
    log(f"💓 Keepalive ping from {source[:60]}{gap}")


@app.get("/api/health")
def health_check(x_keepalive_source: Optional[str] = Header(None)):
    # The keepalive scheduled by migration 011 announces itself, because the
    # platform's own health probe hits this same path and the two are otherwise
    # indistinguishable in the access log. Saying so once per ping is what makes
    # "was the backend kept awake last night?" answerable from the log alone,
    # and the gap between consecutive lines is the answer to "did the schedule
    # actually fire?".
    if x_keepalive_source:
        _note_keepalive_ping(x_keepalive_source)

    active_engine = f"OpenAI Vision ({OPENAI_VISION_MODEL})" if openai_available else (f"Gemini Vision ({GEMINI_VISION_MODEL})" if genai_available else "Goshwara Dr/Cr Accounting Engine")
    return {
        "status": "online",
        "service": "Scan2Tally FastAPI Server",
        "vision_ai_engine": active_engine,
        "ai_provider": AI_PROVIDER,
        "openai_configured": openai_available,
        "gemini_configured": genai_available,
        "opencv": "Enabled",
        # Serving HTTP and extracting vouchers are separate things, and this
        # endpoint used to report only the first. A dead queue consumer looked
        # exactly like a healthy service, which is how a stopped platform could
        # go unnoticed indefinitely. Reported rather than failed on purpose:
        # turning this into a non-200 would have the host restart a backend that
        # is still perfectly able to serve the app.
        "workers": _worker_state,
    }

async def run_extraction(raw_bytes: bytes, content_type: str, filename: str) -> dict:
    """Reads one voucher image and returns the extraction result.

    Deliberately free of any request or database context: the same pipeline is
    driven both by the direct endpoint below and by the background job runner,
    which has no browser attached to it.
    """
    # Send original image bytes directly to AI — OpenCV grayscale conversion hurts OCR accuracy
    extracted_transactions = []
    error_msg = None
    stated_totals = {}  # the voucher's own जम्मा row, when the engine could read it
    voucher_no: Optional[str] = None  # handwritten number beside भौचर नं.
    has_signature: Optional[bool] = None  # None until the totals request answers it
    consensus_notes: List[str] = []
    progress = extraction_progress()

    # Resized ONCE, here, and shared by every concurrent request below. Doing it
    # per request meant every pass re-did identical work on identical bytes.
    if openai_available or genai_available:
        image_bytes, media_type = prepare_vision_image(raw_bytes, content_type)
    else:
        image_bytes, media_type = raw_bytes, content_type

    # 1. Live OpenAI Extraction
    if openai_available:
        log(f"🤖 Sending image to OpenAI {OPENAI_VISION_MODEL}... (size: {len(image_bytes)} bytes)")
        try:
            base64_image = base64.b64encode(image_bytes).decode('utf-8')
            # A data: URL in an image_url part has to claim an image type, so a
            # PDF that reached here is labelled as one, exactly as before.
            openai_media_type = (
                media_type if media_type.startswith("image/") else "image/jpeg"
            )

            # Transcription and total-reading are issued as SEPARATE requests, run
            # concurrently. Keeping the जम्मा total out of the transcription prompt
            # is the whole point: when the model is shown the total in the same
            # breath it back-solves the line items to match it, producing different
            # invented numbers on every run that all sum to the stated total.
            # Several independent transcriptions then let us see which individual
            # cells the model cannot read consistently.
            calls = [
                (openai_transcribe, (base64_image, openai_media_type), {})
                for _ in range(OCR_CONSENSUS_RUNS)
            ]
            calls.append((openai_read_totals, (base64_image, openai_media_type), {}))
            progress.vision_sent(
                len(calls), f"OpenAI {OPENAI_VISION_MODEL}", OCR_CONSENSUS_RUNS
            )
            runs = await _run_blocking_provider_calls(
                calls, on_settled=progress.vision_response
            )
            transcripts = [r for r in runs[:-1] if not isinstance(r, Exception) and r]
            totals_result = runs[-1]

            failures = [r for r in runs if isinstance(r, Exception)]
            if failures and not transcripts:
                raise failures[0]

            if not transcripts:
                error_msg = INVALID_JOURNAL_IMAGE_ERROR
                log("❌ OpenAI returned no readable journal entry content")
            else:
                extracted_transactions, consensus_notes = build_consensus(transcripts)
                progress.step(
                    _PROGRESS_CONSENSUS,
                    "consensus built",
                    f"{len(extracted_transactions)} rows from "
                    f"{len(transcripts)}/{OCR_CONSENSUS_RUNS} usable passes",
                )

                # Comparing independent passes is what catches an invented
                # amount, so losing passes quietly weakens the one check the
                # reviewer is relying on. Say it in the receipt's warnings, not
                # just in the server log nobody is reading.
                if len(transcripts) < OCR_CONSENSUS_RUNS:
                    detail = extraction_error_message("OpenAI Vision", failures[0]) if failures else ""
                    consensus_notes = [
                        f"Only {len(transcripts)} of {OCR_CONSENSUS_RUNS} transcription passes completed"
                        + (f" ({detail})" if detail else "")
                        + (". Amounts on this voucher were not cross-checked between passes, "
                           "so please verify every row against the original."
                           if len(transcripts) == 1 else
                           ". Cross-checking was weaker than usual — please verify the amounts.")
                    ] + consensus_notes

                if isinstance(totals_result, Exception):
                    # Never fail the extraction over this — but say so, otherwise
                    # a broken totals call silently disables the whole check.
                    log(f"⚠️ Could not read the जम्मा total row: {_describe_error(totals_result)}")
                elif totals_result:
                    stated_totals = read_stated_totals(totals_result)
                    has_signature = read_signature_flag(totals_result)
                    voucher_no = read_voucher_no(totals_result)
                log(f"✅ Extracted {len(extracted_transactions)} transactions from OpenAI "
                      f"({len(transcripts)}/{OCR_CONSENSUS_RUNS} transcription runs agreed on structure)")
                for note in consensus_notes:
                    log(f"⚠️ Consensus: {note}")
        except Exception as err:
            error_msg = extraction_error_message("OpenAI Vision", err)
            log(f"❌ {error_msg}")
    elif genai_available:
        # 2. Live Gemini Extraction — the AI_PROVIDER=gemini counterpart of the
        # OpenAI block above. Deliberately built to the same shape (separate
        # transcription and totals requests, OCR_CONSENSUS_RUNS independent
        # passes reconciled by build_consensus) so the two providers produce
        # equivalent output and neither one is checked less carefully than
        # the other.
        log(f"🤖 Sending image to Gemini {GEMINI_VISION_MODEL}... (size: {len(image_bytes)} bytes)")
        try:
            calls = [
                (gemini_transcribe, (image_bytes, media_type), {})
                for _ in range(OCR_CONSENSUS_RUNS)
            ]
            calls.append((gemini_read_totals, (image_bytes, media_type), {}))
            progress.vision_sent(
                len(calls), f"Gemini {GEMINI_VISION_MODEL}", OCR_CONSENSUS_RUNS
            )
            runs = await _run_blocking_provider_calls(
                calls, on_settled=progress.vision_response
            )
            transcripts = [r for r in runs[:-1] if not isinstance(r, Exception) and r]
            totals_result = runs[-1]

            failures = [r for r in runs if isinstance(r, Exception)]
            if failures and not transcripts:
                raise failures[0]

            if not transcripts:
                error_msg = INVALID_JOURNAL_IMAGE_ERROR
                log("❌ Gemini returned no readable journal entry content")
            else:
                extracted_transactions, consensus_notes = build_consensus(transcripts)
                progress.step(
                    _PROGRESS_CONSENSUS,
                    "consensus built",
                    f"{len(extracted_transactions)} rows from "
                    f"{len(transcripts)}/{OCR_CONSENSUS_RUNS} usable passes",
                )

                if len(transcripts) < OCR_CONSENSUS_RUNS:
                    detail = extraction_error_message("Gemini Vision", failures[0]) if failures else ""
                    consensus_notes = [
                        f"Only {len(transcripts)} of {OCR_CONSENSUS_RUNS} transcription passes completed"
                        + (f" ({detail})" if detail else "")
                        + (". Amounts on this voucher were not cross-checked between passes, "
                           "so please verify every row against the original."
                           if len(transcripts) == 1 else
                           ". Cross-checking was weaker than usual — please verify the amounts.")
                    ] + consensus_notes

                if isinstance(totals_result, Exception):
                    log(f"⚠️ Could not read the जम्मा total row: {_describe_error(totals_result)}")
                elif totals_result:
                    stated_totals = read_stated_totals(totals_result)
                    has_signature = read_signature_flag(totals_result)
                    voucher_no = read_voucher_no(totals_result)
                log(f"✅ Extracted {len(extracted_transactions)} transactions from Gemini "
                      f"({len(transcripts)}/{OCR_CONSENSUS_RUNS} transcription runs agreed on structure)")
                for note in consensus_notes:
                    log(f"⚠️ Consensus: {note}")
        except Exception as err:
            error_msg = extraction_error_message("Gemini Vision", err)
            log(f"❌ {error_msg}")
    else:
        log(f"⚠️ No AI vision engine available for AI_PROVIDER='{AI_PROVIDER}' (key missing or invalid)")

    # 3. Goshwara Accounting Classification Engine (offline demo fallback only —
    # never used once a real Vision AI engine is configured, so genuine
    # zero-result extractions aren't silently replaced with fake demo data)
    if not extracted_transactions and not openai_available and not genai_available:
        extracted_transactions = classify_voucher_image_content(raw_bytes, filename)
        if extracted_transactions:
            log(f"📋 Using demo classification engine: {len(extracted_transactions)} rows")
            progress.step(
                _PROGRESS_CONSENSUS,
                "read by the offline demo engine",
                f"{len(extracted_transactions)} rows, no vision provider configured",
            )

    log(f"🔚 Final result: {len(extracted_transactions)} transactions, error={error_msg}")

    # The dedicated header read is a fallback for transcription passes that
    # correctly read the rows but omit the voucher number field.
    if voucher_no:
        for transaction in extracted_transactions:
            transaction["voucher_no"] = transaction.get("voucher_no") or voucher_no

    # Reconcile against the voucher's own printed totals. Reporting only —
    # a discrepancy never rewrites an amount, it just tells the reviewer where
    # to look, so extraction stays "Extracted" and the rows remain editable.
    verification = verify_against_stated_totals(extracted_transactions, stated_totals)

    # Cells the transcription passes disagreed on are surfaced first: they point
    # at a specific row to re-check, which is more actionable than a bare total
    # mismatch, and they catch misreads that happen to leave the totals intact.
    if consensus_notes:
        verification["warnings"] = consensus_notes + verification["warnings"]
        verification["consensus_disagreement"] = True
    verification["rows_needing_review"] = [
        t.get("ledger_name") or f"row {i + 1}"
        for i, t in enumerate(extracted_transactions) if t.get("needs_review")
    ]

    if verification["warnings"]:
        for warning in verification["warnings"]:
            log(f"⚠️ Verification: {warning}")
    elif verification["checked_against_voucher"]:
        log("✅ Verification: line items reconcile with the voucher's जम्मा totals")

    # Only advanced on a reading that produced rows. Stepping here after a
    # failure would show the extraction climbing past a point it never reached.
    if not error_msg and extracted_transactions:
        if verification["checked_against_voucher"]:
            detail = (
                f"{len(verification['warnings'])} warning(s)"
                if verification["warnings"]
                else "line items reconcile with the जम्मा totals"
            )
        else:
            detail = "the जम्मा total row could not be read; rows left unchecked"
        progress.step(_PROGRESS_VERIFIED, "verified against the voucher", detail)

    return {
        "filename": filename,
        "engine_used": (
            f"OpenAI {OPENAI_VISION_MODEL}" if openai_available
            else (f"Gemini {GEMINI_VISION_MODEL}" if genai_available else "Dr/Cr Accounting Engine")
        ),
        "status": "Extracted" if not error_msg else "Failed",
        "transactions": extracted_transactions,
        "error": error_msg,
        "verification": verification,
        "has_signature": has_signature
    }


@app.post("/api/extract-receipt")
async def extract_receipt():
    """Closes the legacy upload-and-wait path that bypassed the global queue."""
    raise HTTPException(
        status_code=410,
        detail=(
            "Direct extraction has been retired. Upload the receipt to a batch "
            "and start its durable queued extraction instead."
        ),
    )

class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str  # 'Super Admin' | 'Admin' | 'Operator'
    designation: Optional[str] = ""
    phone: Optional[str] = ""
    # Only honoured for a Super Admin caller. An Admin always creates into their
    # own organisation, whatever the request body claims.
    organization_id: Optional[str] = None


class UpdateUserRequest(BaseModel):
    name: str
    email: str
    role: str
    designation: Optional[str] = ""
    phone: Optional[str] = ""
    password: Optional[str] = ""
    organization_id: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    password: str


def _svc_headers() -> dict:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def _storage_object_bytes(item: dict) -> int:
    """Returns an object's byte size from the Storage API metadata."""
    metadata = item.get("metadata") if isinstance(item, dict) else None
    if not isinstance(metadata, dict):
        return 0
    raw_size = metadata.get("size", metadata.get("contentLength", 0))
    try:
        return max(0, int(raw_size or 0))
    except (TypeError, ValueError):
        return 0


async def fetch_storage_usage_via_api(client: httpx.AsyncClient) -> dict:
    """Collects current Storage usage when the optional SQL metric is absent.

    Supabase's list endpoint is folder-scoped, so every discovered prefix is
    traversed and paginated. The request cap prevents malformed folder data from
    turning a monitoring request into an unbounded crawl.
    """
    bucket_result = await client.get(
        f"{SUPABASE_URL}/storage/v1/bucket",
        headers=_svc_headers(),
    )
    if bucket_result.status_code != 200:
        raise RuntimeError("Supabase Storage did not return its buckets.")

    buckets = bucket_result.json()
    if not isinstance(buckets, list):
        raise RuntimeError("Supabase Storage returned an invalid bucket list.")

    total_bytes = 0
    total_objects = 0
    by_bucket = {}
    request_count = 1

    for bucket in buckets:
        bucket_id = bucket.get("id") if isinstance(bucket, dict) else None
        if not bucket_id:
            continue

        bucket_bytes = 0
        pending_prefixes = [""]
        seen_prefixes = {""}
        prefix_index = 0

        while prefix_index < len(pending_prefixes):
            prefix = pending_prefixes[prefix_index]
            prefix_index += 1
            offset = 0

            while True:
                request_count += 1
                if request_count > STORAGE_LIST_MAX_REQUESTS:
                    raise RuntimeError("Supabase Storage contains too many folders to scan safely.")

                object_result = await client.post(
                    f"{SUPABASE_URL}/storage/v1/object/list/{quote(str(bucket_id), safe='')}",
                    headers=_svc_headers(),
                    json={
                        "prefix": prefix,
                        "limit": STORAGE_LIST_PAGE_SIZE,
                        "offset": offset,
                        "sortBy": {"column": "name", "order": "asc"},
                    },
                )
                if object_result.status_code != 200:
                    raise RuntimeError("Supabase Storage did not return its objects.")

                items = object_result.json()
                if not isinstance(items, list):
                    raise RuntimeError("Supabase Storage returned an invalid object list.")

                for item in items:
                    if not isinstance(item, dict):
                        continue
                    name = str(item.get("name") or "").strip("/")
                    if not name:
                        continue
                    object_path = f"{prefix}/{name}".strip("/")
                    if item.get("id") is None:
                        if object_path not in seen_prefixes:
                            seen_prefixes.add(object_path)
                            pending_prefixes.append(object_path)
                        continue

                    total_objects += 1
                    bucket_bytes += _storage_object_bytes(item)

                if len(items) < STORAGE_LIST_PAGE_SIZE:
                    break
                offset += len(items)

        by_bucket[str(bucket_id)] = bucket_bytes
        total_bytes += bucket_bytes

    return {
        "database_bytes": None,
        "storage_bytes": total_bytes,
        "storage_objects": total_objects,
        "storage_by_bucket": by_bucket,
    }


async def fetch_platform_usage_snapshot() -> dict:
    """Returns a shared, short-lived snapshot for the Super Admin dashboard."""
    global _capacity_snapshot_cache, _capacity_snapshot_expires_at

    loop = asyncio.get_running_loop()
    now = loop.time()
    if _capacity_snapshot_cache is not None and now < _capacity_snapshot_expires_at:
        return _capacity_snapshot_cache

    async with _capacity_snapshot_lock:
        now = loop.time()
        if _capacity_snapshot_cache is not None and now < _capacity_snapshot_expires_at:
            return _capacity_snapshot_cache

        async with httpx.AsyncClient(timeout=20) as client:
            result = await client.post(
                f"{SUPABASE_URL}/rest/v1/rpc/get_platform_usage",
                headers=_svc_headers(),
                json={},
            )
            snapshot = None
            if result.status_code == 200:
                try:
                    rows = result.json() or []
                except ValueError:
                    rows = []
                if isinstance(rows, list) and rows and isinstance(rows[0], dict):
                    snapshot = rows[0]

            # Migration 004 is the preferred single-query source because it
            # also includes database size. The API fallback still gives an
            # exact file-storage snapshot during deployment or local setup.
            if snapshot is None:
                snapshot = await fetch_storage_usage_via_api(client)

        snapshot = dict(snapshot)
        snapshot["checked_at"] = datetime.now(timezone.utc).isoformat()
        _capacity_snapshot_cache = snapshot
        _capacity_snapshot_expires_at = loop.time() + CAPACITY_CACHE_SECONDS
        return snapshot


async def publish_capacity_alerts_once(client: httpx.AsyncClient) -> int:
    """Atomically refreshes the Realtime alert rows through a protected RPC.

    The database function calculates both metrics in one transaction and only
    writes when a resource changes severity. That makes repeated calls cheap
    for subscribers and safe when several backend processes tick together.
    """
    result = await client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/refresh_platform_capacity_alerts",
        headers=_svc_headers(),
        json={
            "p_storage_quota_bytes": STORAGE_QUOTA_BYTES,
            "p_database_quota_bytes": DATABASE_QUOTA_BYTES,
            "p_warning_percent": USAGE_WARNING_PERCENT,
            "p_critical_percent": USAGE_CRITICAL_PERCENT,
        },
    )
    if result.status_code != 200:
        raise RuntimeError(
            f"Supabase capacity alert refresh failed with status {result.status_code}."
        )

    try:
        transitions = result.json()
    except ValueError as err:
        raise RuntimeError("Supabase returned an invalid capacity alert response.") from err
    try:
        return max(0, int(transitions or 0))
    except (TypeError, ValueError) as err:
        raise RuntimeError("Supabase returned an invalid capacity transition count.") from err


async def publish_capacity_alerts() -> None:
    """Publishes current warning states for the lifetime of this server.

    Admins and Operators subscribe to the persisted rows through Supabase
    Realtime. They never need the exact-metric endpoint, and a warning that was
    raised before they signed in remains available for their initial table read.
    """
    if not supabase_admin_available:
        return

    previous_error = None
    async with httpx.AsyncClient(timeout=20) as client:
        while True:
            try:
                await publish_capacity_alerts_once(client)
                if previous_error is not None:
                    log("✅ Supabase capacity alert publisher reconnected")
                previous_error = None
            except asyncio.CancelledError:
                raise
            except Exception as err:
                # Monitoring is advisory and must never take the API down. The
                # previous persisted warning remains visible while this retries.
                # Log only when the failure changes, rather than every interval.
                error_text = str(err)
                if error_text != previous_error:
                    log(f"⚠️ Could not refresh capacity alerts: {error_text}")
                previous_error = error_text
            await asyncio.sleep(CAPACITY_ALERT_INTERVAL_SECONDS)


async def resolve_caller(authorization: Optional[str]) -> dict:
    """Identify who is making the request, from their own session token.

    The caller's role is read from the database rather than taken from anything
    they sent, so a client cannot promote itself by editing a request body.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="You must be signed in to do this.")
    token = authorization.split(" ", 1)[1].strip()

    async with httpx.AsyncClient(timeout=20) as client:
        # Validates the token: Supabase rejects anything expired or forged.
        who = await client.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {token}"},
        )
        if who.status_code != 200:
            raise HTTPException(status_code=401, detail="Your session has expired. Please sign in again.")
        auth_id = who.json().get("id")

        profile = await client.get(
            f"{SUPABASE_URL}/rest/v1/users",
            headers=_svc_headers(),
            params={"select": "id,role,organization_id,status", "id": f"eq.{auth_id}"},
        )
        rows = profile.json() if profile.status_code == 200 else []

    if not rows:
        raise HTTPException(status_code=403, detail="Your account has no profile set up.")
    caller = rows[0]
    if caller.get("status") == "Inactive":
        raise HTTPException(status_code=403, detail="This account has been deactivated.")
    return caller


@app.get("/api/platform-usage")
async def get_platform_usage(authorization: Optional[str] = Header(None)):
    """Returns exact project capacity details to the Super Admin only.

    Admins and Operators receive their warning states from the protected
    Realtime alert table instead of polling this endpoint.
    """
    if not supabase_admin_available:
        raise HTTPException(status_code=503, detail="Capacity monitoring is not configured on this server.")

    caller = await resolve_caller(authorization)
    if caller.get("role") != "Super Admin":
        raise HTTPException(
            status_code=403,
            detail="Only the Super Admin can view exact platform capacity metrics.",
        )
    try:
        snapshot = await fetch_platform_usage_snapshot()
    except (RuntimeError, httpx.HTTPError, ValueError):
        raise HTTPException(
            status_code=503,
            detail="Live Supabase capacity is temporarily unavailable.",
        )

    return build_platform_usage_response(snapshot, caller.get("role") or "")


@app.get("/api/team-directory")
async def get_operator_team_directory(authorization: Optional[str] = Header(None)):
    """Return a privacy-limited, same-organization directory to Operators.

    This intentionally runs through the authenticated backend rather than
    broadening SELECT access on public.users. Only the four fields rendered by
    the read-only UI leave the server.
    """
    if not supabase_admin_available:
        raise HTTPException(status_code=503, detail="The team directory is temporarily unavailable.")

    caller = await resolve_caller(authorization)
    if caller.get("role") != "Operator":
        raise HTTPException(status_code=403, detail="This directory is available to Operators only.")

    organization_id = caller.get("organization_id")
    if not organization_id:
        raise HTTPException(status_code=403, detail="Your account is not linked to an organization.")

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                f"{SUPABASE_URL}/rest/v1/users",
                headers=_svc_headers(),
                params={
                    "select": "id,name,designation,role",
                    "organization_id": f"eq.{organization_id}",
                    "status": "eq.Active",
                    "order": "name.asc,id.asc",
                },
            )
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="The team directory is temporarily unavailable.")

    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="The team directory is temporarily unavailable.")
    try:
        rows = response.json()
    except ValueError:
        raise HTTPException(status_code=503, detail="The team directory is temporarily unavailable.")
    if not isinstance(rows, list):
        raise HTTPException(status_code=503, detail="The team directory is temporarily unavailable.")

    # Whitelist every output key; a future SELECT change must not accidentally
    # expose email, phone, status, organization ids or account metadata.
    return {
        "members": [
            {
                "id": row.get("id"),
                "name": row.get("name"),
                "designation": row.get("designation"),
                "role": row.get("role"),
            }
            for row in rows
            if isinstance(row, dict)
            and row.get("id")
            and row.get("name")
            and row.get("role") in ("Admin", "Operator")
        ]
    }


@app.post("/api/users")
async def create_user(payload: CreateUserRequest, authorization: Optional[str] = Header(None)):
    """Creates a login on behalf of an administrator."""
    if not supabase_admin_available:
        raise HTTPException(status_code=503, detail="User management is not configured on this server.")

    caller = await resolve_caller(authorization)
    caller_role = caller.get("role")

    email = (payload.email or "").strip().lower()
    name = (payload.name or "").strip().lower().title()
    designation = (payload.designation or "").strip().lower().title()
    if not name:
        raise HTTPException(status_code=400, detail="Please enter the person's name.")
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")
    if len(payload.password or "") < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if payload.role not in ("Super Admin", "Admin", "Operator"):
        raise HTTPException(status_code=400, detail="Unknown role.")

    # Super Admin accounts are provisioned outside team management. No user,
    # including an existing Super Admin, may create another one here.
    if payload.role == "Super Admin":
        raise HTTPException(status_code=403, detail="Super Admin accounts cannot be created here.")

    # Who may create whom. An Admin is confined to their own organisation and
    # cannot mint a Super Admin, which would be a straight privilege escalation.
    if caller_role == "Super Admin":
        organization_id = payload.organization_id
        if payload.role != "Super Admin" and not organization_id:
            raise HTTPException(status_code=400, detail="Choose an organisation for this user.")
    elif caller_role == "Admin":
        if payload.role not in ("Admin", "Operator"):
            raise HTTPException(status_code=403, detail="Admins can only create Admin or Operator accounts.")
        organization_id = caller.get("organization_id")
        if not organization_id:
            raise HTTPException(status_code=403, detail="Your account is not linked to an organisation.")
    else:
        raise HTTPException(status_code=403, detail="Only administrators can create accounts.")

    async with httpx.AsyncClient(timeout=30) as client:
        if organization_id:
            org = await client.get(
                f"{SUPABASE_URL}/rest/v1/organizations",
                headers=_svc_headers(),
                params={"select": "status", "id": f"eq.{organization_id}"},
            )
            org_rows = org.json() if org.status_code == 200 else []
            if not org_rows:
                raise HTTPException(status_code=400, detail="That organisation does not exist.")
            # A deactivated organisation is suspended; staff should not be
            # addable to it until it is reactivated. The UI already hides
            # inactive organisations from the picker - this is the backstop
            # for a request made directly against the API.
            if org_rows[0].get("status") != "Active":
                raise HTTPException(status_code=400, detail="That organisation is deactivated. Reactivate it before adding staff.")

        existing = await client.get(
            f"{SUPABASE_URL}/rest/v1/users",
            headers=_svc_headers(),
            params={"select": "id", "email": f"eq.{email}"},
        )
        if existing.status_code == 200 and existing.json():
            raise HTTPException(status_code=409, detail="An account with that email already exists.")

        created = await client.post(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            headers=_svc_headers(),
            json={"email": email, "password": payload.password, "email_confirm": True},
        )
        if created.status_code not in (200, 201):
            detail = created.json().get("msg") or created.json().get("message") or "Could not create the login."
            raise HTTPException(status_code=400, detail=detail)
        new_id = created.json().get("id")

        profile = await client.post(
            f"{SUPABASE_URL}/rest/v1/users",
            headers={**_svc_headers(), "Prefer": "return=representation"},
            json={
                "id": new_id,
                "organization_id": organization_id,
                "name": name,
                "email": email,
                "phone": payload.phone or None,
                "designation": designation or None,
                "role": payload.role,
                "status": "Active",
                "created_by": caller.get("id"),
            },
        )
        if profile.status_code not in (200, 201):
            # Undo the login, or the person could sign in to an account with no
            # profile and the app could only show them an error.
            await client.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{new_id}", headers=_svc_headers())
            raise HTTPException(status_code=400, detail="Could not create the user profile, so the login was removed.")

    return {"id": new_id, "name": name, "email": email, "role": payload.role,
            "organization_id": organization_id, "status": "Active"}


async def _load_target_user(client: httpx.AsyncClient, user_id: str, caller: dict) -> dict:
    # These endpoints use the service-role key after this check, so RLS cannot
    # protect them. Reject Operators before even looking up the target: knowing
    # a same-org UUID must never turn a read-only directory into account control.
    if caller.get("role") not in ("Super Admin", "Admin"):
        raise HTTPException(status_code=403, detail="Only administrators can manage team members.")

    response = await client.get(
        f"{SUPABASE_URL}/rest/v1/users",
        headers=_svc_headers(),
        params={"select": "id,organization_id,role,status", "id": f"eq.{user_id}"},
    )
    rows = response.json() if response.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=404, detail="That team member was not found.")
    target = rows[0]
    if caller.get("role") != "Super Admin" and (
        target.get("organization_id") != caller.get("organization_id")
        or target.get("id") == caller.get("id")
    ):
        raise HTTPException(status_code=403, detail="You cannot manage that team member.")
    return target


@app.patch("/api/users/{user_id}")
async def update_user(user_id: str, payload: UpdateUserRequest, authorization: Optional[str] = Header(None)):
    if not supabase_admin_available:
        raise HTTPException(status_code=503, detail="User management is not configured on this server.")

    caller = await resolve_caller(authorization)
    name = (payload.name or "").strip().lower().title()
    email = (payload.email or "").strip().lower()
    designation = (payload.designation or "").strip().lower().title()
    phone = (payload.phone or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Please enter the person's name.")
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")
    if payload.role not in ("Admin", "Operator"):
        raise HTTPException(status_code=400, detail="Team members can only be Admin or Operator accounts.")
    if payload.password and len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    async with httpx.AsyncClient(timeout=30) as client:
        target = await _load_target_user(client, user_id, caller)
        if target.get("role") == "Super Admin":
            raise HTTPException(status_code=403, detail="Super Admin accounts cannot be managed here.")
        organization_id = payload.organization_id if caller.get("role") == "Super Admin" else caller.get("organization_id")
        if not organization_id:
            raise HTTPException(status_code=400, detail="Choose an organisation for this user.")

        existing = await client.get(
            f"{SUPABASE_URL}/rest/v1/users", headers=_svc_headers(),
            params={"select": "id", "email": f"eq.{email}", "id": f"neq.{user_id}"},
        )
        if existing.status_code == 200 and existing.json():
            raise HTTPException(status_code=409, detail="An account with that email already exists.")

        auth_update = {"email": email, "email_confirm": True}
        if payload.password:
            auth_update["password"] = payload.password
        auth_response = await client.put(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}", headers=_svc_headers(), json=auth_update
        )
        if auth_response.status_code not in (200, 201):
            detail = auth_response.json().get("message") or "Could not update the login."
            raise HTTPException(status_code=400, detail=detail)

        profile = await client.patch(
            f"{SUPABASE_URL}/rest/v1/users", headers={**_svc_headers(), "Prefer": "return=representation"},
            params={"id": f"eq.{user_id}"},
            json={"name": name, "email": email, "phone": phone or None, "designation": designation or None,
                  "role": payload.role, "organization_id": organization_id},
        )
        if profile.status_code not in (200, 204):
            raise HTTPException(status_code=400, detail="The login changed, but the user profile could not be updated.")

    return {"id": user_id, "name": name, "email": email, "phone": phone or None,
            "designation": designation or None, "role": payload.role,
            "organization_id": organization_id, "status": target.get("status", "Active")}


@app.patch("/api/users/{user_id}/password")
async def change_user_password(user_id: str, payload: ChangePasswordRequest,
                               authorization: Optional[str] = Header(None)):
    """Changes only the Supabase login password; the profile is untouched."""
    if not supabase_admin_available:
        raise HTTPException(status_code=503, detail="User management is not configured on this server.")
    if len(payload.password or "") < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    caller = await resolve_caller(authorization)
    async with httpx.AsyncClient(timeout=30) as client:
        target = await _load_target_user(client, user_id, caller)
        if target.get("role") == "Super Admin":
            raise HTTPException(status_code=403, detail="Super Admin accounts cannot be managed here.")
        response = await client.put(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers=_svc_headers(),
            json={"password": payload.password},
        )
        if response.status_code not in (200, 201):
            detail = response.json().get("message") or "Could not change the password."
            raise HTTPException(status_code=400, detail=detail)

    return {"id": user_id}


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str, authorization: Optional[str] = Header(None)):
    if not supabase_admin_available:
        raise HTTPException(status_code=503, detail="User management is not configured on this server.")

    caller = await resolve_caller(authorization)
    async with httpx.AsyncClient(timeout=30) as client:
        target = await _load_target_user(client, user_id, caller)
        if target.get("role") == "Super Admin":
            raise HTTPException(status_code=403, detail="Super Admin accounts cannot be deleted here.")

        # The account is explicitly destructive: remove rows that reference the
        # profile before deleting auth.users (which cascades to public.users).
        # Otherwise scan_batches.created_by and the other required audit FKs
        # correctly reject the auth deletion.
        dependent_deletes = (
            ("receipts", {"uploaded_by": f"eq.{user_id}"}),
            ("exports", {"generated_by": f"eq.{user_id}"}),
            ("scan_batches", {"created_by": f"eq.{user_id}"}),
        )
        for table, params in dependent_deletes:
            response = await client.delete(
                f"{SUPABASE_URL}/rest/v1/{table}",
                headers={**_svc_headers(), "Prefer": "return=minimal"},
                params=params,
            )
            if response.status_code not in (200, 204):
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not remove the account's linked {table} records.",
                )

        # These references are optional, so preserve the rows while removing
        # the deleted user's identity from their audit fields.
        for table, column in (("users", "created_by"), ("ledgers", "created_by"), ("transactions", "updated_by")):
            response = await client.patch(
                f"{SUPABASE_URL}/rest/v1/{table}",
                headers={**_svc_headers(), "Prefer": "return=minimal"},
                params={column: f"eq.{user_id}"},
                json={column: None},
            )
            if response.status_code not in (200, 204):
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not clear the account's audit references in {table}.",
                )

        deleted = await client.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}", headers=_svc_headers()
        )
        if deleted.status_code not in (200, 204):
            try:
                error_body = deleted.json()
            except Exception:
                error_body = {}
            raw_detail = " ".join(
                str(error_body.get(key) or "") for key in ("message", "details", "hint", "code")
            )
            detail = error_body.get("message") or "Could not delete the login."
            raise HTTPException(status_code=400, detail=detail)
    return {"id": user_id}


# ---------------------------------------------------------------- background extraction
#
# The browser must not own an extraction. Reading a voucher takes tens of
# seconds, and while the work lives inside the tab's HTTP request, closing the
# tab, refreshing, or shutting the laptop lid abandons it half-finished — the
# receipt is left on "Processing" with nothing in existence able to complete it.
#
# So the server owns the job instead. It fetches the image from storage itself,
# runs the extraction, and writes both the rows and the final status straight to
# the database. The tab's only jobs are to start the work and to watch the
# receipt row, which leaves it free to disappear at any moment.

STORAGE_BUCKET = "receipts"

# The durable queue enforces one extraction across the whole deployment. The
# semaphore remains for databases that have not applied migration 007, where it
# deliberately forces the backwards-compatible path to one job per process.
EXTRACTION_CONCURRENCY = 1

# PGMQ polling and visibility are controlled by the backend worker, while the
# database owns the singleton lease and fencing token. The initial lease must
# cover the full extraction plus enough time to persist a terminal result even
# before its first refresh; heartbeats then keep extending that same window.
EXTRACTION_FINALIZATION_MARGIN_SECONDS = max(
    60,
    int(_positive_env_number("EXTRACTION_FINALIZATION_MARGIN_SECONDS", 300.0)),
)
EXTRACTION_QUEUE_POLL_SECONDS = max(
    0.5,
    _positive_env_number("EXTRACTION_QUEUE_POLL_SECONDS", 2.0),
)
EXTRACTION_QUEUE_ABSENCE_GRACE_SECONDS = max(
    10.0,
    _positive_env_number("EXTRACTION_QUEUE_ABSENCE_GRACE_SECONDS", 30.0),
)
EXTRACTION_QUEUE_VISIBILITY_SECONDS = max(
    EXTRACTION_TIMEOUT_SECONDS + EXTRACTION_FINALIZATION_MARGIN_SECONDS,
    int(_positive_env_number("EXTRACTION_QUEUE_VISIBILITY_SECONDS", 900.0)),
)
EXTRACTION_QUEUE_HEARTBEAT_SECONDS = min(
    EXTRACTION_QUEUE_VISIBILITY_SECONDS / 3,
    max(5.0, _positive_env_number("EXTRACTION_QUEUE_HEARTBEAT_SECONDS", 30.0)),
)
EXTRACTION_QUEUE_MAX_ATTEMPTS = max(
    1,
    int(_positive_env_number("EXTRACTION_QUEUE_MAX_ATTEMPTS", 3.0)),
)

# How long the slot's holder may go silent before its voucher is handed back.
#
# The visibility window above is sized for how long an extraction may legitimately
# take. It is the wrong instrument for asking whether anyone is still there, and
# using it for that is what makes a crashed backend stall the entire platform —
# extraction is one voucher at a time — for the full window. The heartbeat answers
# the liveness question far sooner, so this is measured in heartbeats.
#
# Four missed beats, never under the database function's own 60s floor. Being
# generous costs only recovery latency, while being tight would take a voucher
# away from a worker that was merely between beats.
EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS = max(
    60,
    int(_positive_env_number(
        "EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS",
        max(120.0, EXTRACTION_QUEUE_HEARTBEAT_SECONDS * 4),
    )),
)

# Set False the first time the RPC turns out to be missing, so a database still
# on migration 009 keeps working exactly as before instead of logging an error
# every poll. Recovery there simply falls back to the visibility timeout.
stale_reclaim_available: Optional[bool] = None

LEDGER_MATCHING_UNAVAILABLE_WARNING = (
    "The chart of accounts could not be reached, so the ledger names on this "
    "voucher were not matched against it. The amounts are unaffected — check the "
    "names before exporting, or retry the extraction."
)

DEFAULT_EXTRACTION_ERROR = "No transaction data could be extracted from this receipt."
INTERRUPTED_NO_IMAGE_ERROR = (
    "Extraction was interrupted and the original image is no longer available. "
    "Please upload it again."
)

# Identifies this process among however many are running. Only ever compared for
# equality — "is this claim mine?" — so any value unique per process will do.
WORKER_ID = os.getenv("WORKER_ID") or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"

# How often a live process reasserts its claims, and how long a claim may go
# unrefreshed before another process may take the work over. The gap between
# them is deliberately several heartbeats wide: a single slow database call must
# never be enough to make a healthy job look abandoned.
CLAIM_HEARTBEAT_SECONDS = 60
CLAIM_STALE_SECONDS = 240

# Fields the job runner needs about a receipt, including its batch's
# organisation — transactions rows cannot be written without that.
_RECEIPT_JOB_FIELDS = "id,filename,file_path,status,batch_id,uploaded_by,scan_batches(organization_id)"
# The current claim, which decides whether the work is already someone else's.
_RECEIPT_CLAIM_FIELDS = "extraction_worker,extraction_claimed_at"


def receipt_job_select() -> str:
    """Which receipt fields to ask for, given what this database actually has.

    The claim columns arrived in migration 002. PostgREST fails the WHOLE query
    when asked for a column that does not exist, so requesting them
    unconditionally would not merely disable claiming on an un-migrated database
    — it would make every receipt look as though it had been deleted.
    """
    if job_claiming_ready:
        return f"{_RECEIPT_JOB_FIELDS},{_RECEIPT_CLAIM_FIELDS}"
    return _RECEIPT_JOB_FIELDS

# Set at start-up by detect_schema_features(). The chart of accounts and the
# claim columns arrived in migration 002, so a database that has not had it
# applied must not be sent rows or patches that carry them.
ledger_matching_ready = False
job_claiming_ready = False
# Migrations 013/014/016 add has_signature, extracted_by and extracted_at. Only
# the pre-007 compatibility path writes these columns directly; PostgREST
# rejects the whole PATCH when asked for a column that does not exist, and
# _patch_receipt does not inspect its response, so an ungated write would leave
# the receipt silently stuck instead of Extracted.
receipt_extraction_metadata_ready = False
MIGRATION_002_REQUIRED_ERROR = (
    "Extraction queue setup is incomplete. Apply "
    "scripts/migrations/002_ledgers_claiming_audit.sql in Supabase, re-run "
    "scripts/migrations/007_sequential_extraction_queue.sql, then restart the "
    "backend."
)
extraction_queue_configuration_error: Optional[str] = None
extraction_queue_absence_first_seen: Optional[float] = None
extraction_queue_absence_confirmations = 0
# True means migration 007 is healthy, False means its health RPC is confirmed
# absent, and None means Supabase could not yet answer. The unknown state must
# never fail open into the legacy worker because that could bypass a queue that
# is merely temporarily unreachable.
extraction_queue_ready: Optional[bool] = None if supabase_admin_available else False

_extraction_semaphore: Optional[asyncio.Semaphore] = None
# Receipts this process is already extracting, so a double-click or an impatient
# retry cannot start the same work twice.
_jobs_in_flight: set = set()
# create_task only holds a weak reference to its task, so without this a job can
# be garbage collected mid-flight and simply vanish.
_background_tasks: set = set()


def _extraction_slot() -> asyncio.Semaphore:
    """Created lazily so it binds to the running event loop, not import time."""
    global _extraction_semaphore
    if _extraction_semaphore is None:
        _extraction_semaphore = asyncio.Semaphore(EXTRACTION_CONCURRENCY)
    return _extraction_semaphore


def _timestamp(moment: datetime) -> str:
    """UTC in a form Postgres reads unambiguously and PostgREST accepts in a filter."""
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> str:
    return _timestamp(datetime.now(timezone.utc))


async def _column_exists(client: httpx.AsyncClient, table: str, column: str) -> bool:
    """Whether a table and column are actually present in this database."""
    res = await client.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_svc_headers(),
        params={"select": column, "limit": "1"},
    )
    if res.status_code == 200:
        return True

    try:
        body = res.json()
    except ValueError:
        body = None
    code = str(body.get("code") or "") if isinstance(body, dict) else ""
    if res.status_code in (400, 404) and code in {
        "42703", "42P01", "PGRST204", "PGRST205",
    }:
        return False

    context = _sanitized_supabase_error_context(res)
    suffix = f" ({context})" if context else ""
    raise RuntimeError(
        f"Supabase schema probe for {table}.{column} failed with status "
        f"{res.status_code}{suffix}."
    )


def _first_rpc_row(payload) -> Optional[dict]:
    """Normalises PostgREST's table-returning RPC shape to zero/one row."""
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, list) and payload and isinstance(payload[0], dict):
        return payload[0]
    return None


async def detect_schema_features() -> None:
    """Works out which optional features this database can support.

    Everything here depends on migration 002. An older deployment without 007
    may keep using the single-process compatibility worker while it upgrades.
    Once any 007 queue objects exist, however, missing 002 prerequisites are a
    broken migration chain and must pause rather than bypass the global queue.
    """
    global ledger_matching_ready, job_claiming_ready, receipt_extraction_metadata_ready
    global extraction_queue_ready, extraction_queue_configuration_error
    global extraction_queue_absence_first_seen, extraction_queue_absence_confirmations
    # A second probe can run in tests or after a transient database failure.
    # Never carry a previous successful queue probe into a failed one.
    ledger_matching_ready = False
    job_claiming_ready = False
    receipt_extraction_metadata_ready = False
    extraction_queue_ready = None if supabase_admin_available else False
    extraction_queue_configuration_error = None
    if not supabase_admin_available:
        extraction_queue_absence_first_seen = None
        extraction_queue_absence_confirmations = 0
        return

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            # Migration 002 is one unit: the queue completion RPC writes the
            # transaction ledger fields and raw audit payload, while claiming
            # needs both receipt claim columns. A lone `ledgers.id` or
            # `extraction_worker` probe can therefore report a partially
            # applied migration as usable and strand every queued receipt.
            schema_probes = await asyncio.gather(
                _column_exists(client, "ledgers", "id"),
                _column_exists(client, "ledgers", "organization_id"),
                _column_exists(client, "ledgers", "name"),
                _column_exists(client, "ledgers", "aliases"),
                _column_exists(client, "ledgers", "is_active"),
                _column_exists(client, "transactions", "ledger_id"),
                _column_exists(client, "transactions", "ledger_match"),
                _column_exists(client, "transactions", "ledger_match_score"),
                _column_exists(client, "receipts", "extraction_worker"),
                _column_exists(client, "receipts", "extraction_claimed_at"),
                _column_exists(client, "receipts", "raw_extraction"),
                _column_exists(client, "receipts", "extraction_queue_message_id"),
                _column_exists(client, "extraction_worker_slot", "slot_id"),
                _column_exists(client, "receipts", "has_signature"),
                _column_exists(client, "receipts", "extracted_by"),
                _column_exists(client, "receipts", "extracted_at"),
            )
            ledger_matching_ready = all(schema_probes[:8])
            job_claiming_ready = all(schema_probes[8:11])
            # Bounded explicitly rather than left open-ended: probes appended
            # after this point are not queue markers, and an open slice would
            # quietly start counting them as evidence that migration 007 exists.
            queue_schema_present = any(schema_probes[11:13])
            receipt_extraction_metadata_ready = all(schema_probes[13:16])
            queue_health = await client.post(
                f"{SUPABASE_URL}/rest/v1/rpc/extraction_queue_health",
                headers=_svc_headers(),
                json={},
            )
            queue_absence_candidate = False
            if queue_health.status_code == 200:
                try:
                    health = _first_rpc_row(queue_health.json())
                except ValueError:
                    health = None
                if not (ledger_matching_ready and job_claiming_ready):
                    # An HTTP-200 health RPC proves migration 007 exists, even
                    # when a hardened version reports ready=false. It cannot
                    # make the migration-002 columns referenced by its lifecycle
                    # RPCs appear, so this is a known configuration error rather
                    # than a temporary connection problem or legacy fallback.
                    extraction_queue_configuration_error = MIGRATION_002_REQUIRED_ERROR
                elif health and health.get("ready") is True:
                    extraction_queue_ready = True
            elif queue_health.status_code == 404:
                # A proxy, paused project, or stale schema gateway can also
                # answer 404. Only PostgREST's precise missing-function code,
                # with no visible 007 markers and a confirmation grace period,
                # may select legacy mode. Every other 404 remains fail-closed.
                try:
                    queue_error = queue_health.json()
                except ValueError:
                    queue_error = None
                if (
                    isinstance(queue_error, dict)
                    and queue_error.get("code") == "PGRST202"
                    and not queue_schema_present
                ):
                    queue_absence_candidate = True

            if queue_absence_candidate:
                now = time.monotonic()
                if extraction_queue_absence_first_seen is None:
                    extraction_queue_absence_first_seen = now
                extraction_queue_absence_confirmations += 1
                if (
                    extraction_queue_absence_confirmations >= 2
                    and now - extraction_queue_absence_first_seen
                    >= EXTRACTION_QUEUE_ABSENCE_GRACE_SECONDS
                ):
                    extraction_queue_ready = False
            else:
                extraction_queue_absence_first_seen = None
                extraction_queue_absence_confirmations = 0
    except Exception as err:
        extraction_queue_absence_first_seen = None
        extraction_queue_absence_confirmations = 0
        log(f"⚠️ Could not check the database schema: {_describe_error(err)}")
        return

    if extraction_queue_configuration_error:
        log(f"❌ {extraction_queue_configuration_error}")
    elif ledger_matching_ready and job_claiming_ready:
        log("✅ Chart-of-accounts matching and job claiming enabled")
    else:
        # Not a fault: everything works. This is a note about one deployment
        # constraint, so it says what to do and when rather than sounding alarmed
        # on every single start-up.
        log(
            "ℹ️ Running in single-process mode (migration 002 not applied). "
            "Fine for development. Before running more than one backend instance, "
            "apply scripts/migrations/002_ledgers_claiming_audit.sql — without it "
            "nothing stops two instances extracting the same receipt twice."
        )

    if extraction_queue_configuration_error:
        return
    if extraction_queue_ready is True:
        log("✅ Durable global sequential extraction queue enabled")
    elif extraction_queue_ready is False:
        log(
            "ℹ️ Durable extraction queue unavailable (migration 007 not applied). "
            "Using the concurrency-one compatibility worker."
        )
    else:
        log(
            "⚠️ Durable extraction queue availability could not be confirmed. "
            "Extraction is paused until Supabase answers the health probe."
        )


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _queue_rpc(client: httpx.AsyncClient, function: str, payload: dict):
    """Calls one service-role-only extraction queue function."""
    res = await client.post(
        f"{SUPABASE_URL}/rest/v1/rpc/{function}",
        headers=_svc_headers(),
        json=payload,
    )
    if res.status_code != 200:
        context = _sanitized_supabase_error_context(res)
        suffix = f" ({context})" if context else ""
        raise RuntimeError(
            f"Extraction queue RPC {function} failed with status "
            f"{res.status_code}{suffix}."
        )
    try:
        return res.json()
    except ValueError as err:
        raise RuntimeError(f"Extraction queue RPC {function} returned invalid JSON.") from err


def _sanitized_supabase_error_context(response: httpx.Response) -> str:
    """Returns useful PostgREST fields without echoing credentials or payloads."""
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""

    secrets = tuple(filter(None, (
        SUPABASE_SERVICE_ROLE_KEY,
        OPENAI_API_KEY,
        GEMINI_API_KEY,
    )))

    def clean(value, limit: int) -> str:
        if isinstance(value, (dict, list)):
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        else:
            text = str(value)
        for secret in secrets:
            text = text.replace(secret, "[redacted]")
        text = re.sub(
            r"(?i)\b(bearer|apikey|api_key|authorization)\s*[:=]?\s*[^\s,;]+",
            r"\1 [redacted]",
            text,
        )
        text = " ".join(text.split())
        return text[:limit]

    parts = []
    for field, limit in (("code", 100), ("message", 500), ("details", 500)):
        value = body.get(field)
        if value not in (None, ""):
            parts.append(f"{field}={clean(value, limit)}")
    return "; ".join(parts)


async def enqueue_extraction_job(
    client: httpx.AsyncClient, receipt_id: str, requested_by: str
) -> dict:
    row = _first_rpc_row(await _queue_rpc(client, "enqueue_receipt_extraction", {
        "p_receipt_id": receipt_id,
        "p_requested_by": requested_by,
    }))
    if not row or not row.get("queue_message_id"):
        raise RuntimeError("Supabase did not return the queued extraction job.")
    return row


async def claim_next_extraction_job(client: httpx.AsyncClient) -> Optional[dict]:
    return _first_rpc_row(await _queue_rpc(client, "claim_next_receipt_extraction", {
        "p_worker_id": WORKER_ID,
        "p_visibility_seconds": EXTRACTION_QUEUE_VISIBILITY_SECONDS,
        "p_max_attempts": EXTRACTION_QUEUE_MAX_ATTEMPTS,
    }))


async def reclaim_stale_extraction_job(client: httpx.AsyncClient) -> Optional[dict]:
    """Frees the slot if its holder has stopped heartbeating.

    Returns what was reclaimed, or None when the slot is free, its holder is
    still alive, or the database has not had migration 010 applied.
    """
    global stale_reclaim_available
    if stale_reclaim_available is False:
        return None
    try:
        result = await _queue_rpc(client, "reclaim_stale_receipt_extraction", {
            "p_stale_after_seconds": EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS,
        })
    except RuntimeError as err:
        # PostgREST answers an unknown function with 404. Anything else is a
        # real fault and must stay noisy rather than silently disabling recovery.
        if "status 404" not in str(err):
            raise
        stale_reclaim_available = False
        log(
            "ℹ️ Stale-extraction reclaim is unavailable (migration 010 not applied). "
            "An interrupted extraction will still recover, but only once its "
            f"{EXTRACTION_QUEUE_VISIBILITY_SECONDS:.0f}s visibility window expires."
        )
        return None

    stale_reclaim_available = True
    return result if isinstance(result, dict) else None


async def heartbeat_extraction_job(client: httpx.AsyncClient, job: dict) -> bool:
    result = await _queue_rpc(client, "heartbeat_receipt_extraction", {
        "p_worker_id": WORKER_ID,
        "p_lease_token": job["lease_token"],
        "p_queue_message_id": job["queue_message_id"],
        "p_visibility_seconds": EXTRACTION_QUEUE_VISIBILITY_SECONDS,
    })
    return result is True


async def complete_extraction_job(
    client: httpx.AsyncClient, job: dict, prepared: dict
) -> bool:
    result = await _queue_rpc(client, "complete_receipt_extraction", {
        "p_worker_id": WORKER_ID,
        "p_lease_token": job["lease_token"],
        "p_queue_message_id": job["queue_message_id"],
        "p_receipt_id": job["receipt_id"],
        "p_transactions": prepared["rows"],
        "p_verification_warnings": prepared["warnings"],
        "p_raw_extraction": prepared.get("raw_extraction"),
        "p_has_signature": prepared.get("has_signature"),
        # Same precedence _run_queued_extraction_job uses to pick the acting
        # user, so the operator credited with the extraction is the one whose
        # request actually ran it — a retry credits the person who retried.
        "p_extracted_by": job.get("requested_by") or job.get("uploaded_by"),
    })
    return result is True


async def fail_extraction_job(
    client: httpx.AsyncClient,
    job: dict,
    message: str,
    raw_extraction: Optional[dict] = None,
) -> bool:
    result = await _queue_rpc(client, "fail_receipt_extraction", {
        "p_worker_id": WORKER_ID,
        "p_lease_token": job["lease_token"],
        "p_queue_message_id": job["queue_message_id"],
        "p_receipt_id": job["receipt_id"],
        "p_error_message": message,
        "p_raw_extraction": raw_extraction,
    })
    return result is True


async def _patch_receipt(client: httpx.AsyncClient, receipt_id: str, patch: dict) -> None:
    await client.patch(
        f"{SUPABASE_URL}/rest/v1/receipts",
        headers=_svc_headers(),
        params={"id": f"eq.{receipt_id}"},
        json=patch,
    )


def _finished(patch: dict) -> dict:
    """Adds the release of this process's claim to a terminal status change.

    A receipt that has stopped being worked on must stop looking claimed, or the
    row keeps naming a worker that is no longer doing anything with it.
    """
    if not job_claiming_ready:
        return patch
    return {**patch, "extraction_worker": None, "extraction_claimed_at": None}


async def _claim_receipt(
    client: httpx.AsyncClient, receipt_id: str, *, only_if_stale: bool
) -> bool:
    """Takes ownership of a receipt for this process. Returns whether it won it.

    The claim is the UPDATE itself, which is what makes this safe with several
    processes running: two of them racing both issue the same conditional write,
    Postgres serialises the pair, and the second finds its condition no longer
    true and updates nothing. PostgREST hands back the rows it changed, so an
    empty response means "someone else got there first" — a decidable answer,
    rather than the read-then-write guess that a status check alone would be.
    """
    params = {"id": f"eq.{receipt_id}"}
    patch = {
        "status": "Processing",
        "error_message": None,
        "verification_warnings": [],
    }

    if job_claiming_ready:
        patch["extraction_worker"] = WORKER_ID
        patch["extraction_claimed_at"] = _now()
        cutoff = _timestamp(datetime.now(timezone.utc) - timedelta(seconds=CLAIM_STALE_SECONDS))
        params["or"] = f"(extraction_claimed_at.is.null,extraction_claimed_at.lt.{cutoff})"
        if only_if_stale:
            params["status"] = "eq.Processing"
        else:
            params["status"] = "in.(Pending,Failed,Processing)"

    res = await client.patch(
        f"{SUPABASE_URL}/rest/v1/receipts",
        headers={**_svc_headers(), "Prefer": "return=representation"},
        params=params,
        json=patch,
    )
    if res.status_code not in (200, 201):
        return False
    # Without the claim columns there is nothing to race over, so the only
    # meaningful question is whether the write landed.
    return bool(res.json()) if job_claiming_ready else True


def _claim_is_live(receipt: dict) -> bool:
    """Whether some process is currently working on this receipt.

    A claim that has stopped being refreshed belonged to a process that died, so
    it is treated as free rather than trusted forever — that is the difference
    between a restart being a pause and being a dead end.
    """
    if not job_claiming_ready:
        return False
    claimed_at = receipt.get("extraction_claimed_at")
    if not claimed_at:
        return False
    try:
        moment = datetime.fromisoformat(str(claimed_at).replace("Z", "+00:00"))
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - moment).total_seconds() < CLAIM_STALE_SECONDS


async def refresh_extraction_claims() -> None:
    """Reasserts this process's claims for as long as it is alive.

    Runs for the lifetime of the server. Failures are logged and shrugged off:
    one missed round is several heartbeats short of a claim going stale, which is
    exactly the margin those constants were chosen to give.
    """
    while True:
        await asyncio.sleep(CLAIM_HEARTBEAT_SECONDS)
        in_flight = list(_jobs_in_flight)
        if not in_flight or not job_claiming_ready:
            continue
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/receipts",
                    headers=_svc_headers(),
                    # Scoped to rows this process still owns, so a job taken over
                    # elsewhere is not quietly reclaimed from under its new owner.
                    params={
                        "id": f"in.({','.join(in_flight)})",
                        "extraction_worker": f"eq.{WORKER_ID}",
                    },
                    json={"extraction_claimed_at": _now()},
                )
        except Exception as err:
            log(f"⚠️ Could not refresh extraction claims: {_describe_error(err)}")


async def _fail_receipt(receipt_id: str, message: str) -> None:
    """Records a terminal failure. Never raises — this is the last line of defence."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            await _patch_receipt(client, receipt_id, _finished({
                "status": "Failed",
                "error_message": message,
                "verification_warnings": [],
            }))
    except Exception as err:
        log(f"⚠️ Could not record failure for receipt {receipt_id}: {_describe_error(err)}")


def normalize_transaction_rows(
    transactions: List[dict],
    receipt_id: str,
    batch_id: str,
    organization_id: str,
    updated_by: Optional[str],
) -> List[dict]:
    """Turns model output into rows the transactions table will accept.

    This mirrors the normalisation the browser used to do, for the same reason
    it existed there: a model may report a line as a flat `amount` with no side,
    and the table's CHECK constraint requires the unused side to be exactly zero.
    """
    rows = []
    for position, t in enumerate(transactions):
        debit = _to_float(t.get("debit_amount"))
        credit = _to_float(t.get("credit_amount"))
        legacy = _to_float(t.get("amount"))

        entry_type = t.get("entry_type")
        if entry_type not in ("Dr", "Cr"):
            entry_type = "Dr" if (debit or (legacy and not credit)) else "Cr"

        rows.append({
            "receipt_id": receipt_id,
            "batch_id": batch_id,
            "organization_id": organization_id,
            "position": position,
            "voucher_date": t.get("voucher_date") or "2083-03-15",
            "voucher_no": str(t.get("voucher_no") or "").strip() or None,
            "voucher_type": t.get("voucher_type") or "Journal",
            "entry_type": entry_type,
            "ledger_name": (
                t.get("ledger_name") or t.get("debit_ledger")
                or t.get("credit_ledger") or "General Account"
            ),
            "debit_amount": (debit or legacy) if entry_type == "Dr" else 0,
            "credit_amount": (credit or legacy) if entry_type == "Cr" else 0,
            "needs_review": t.get("needs_review") is True,
            "narration": normalize_narration(t.get("narration")),
            "updated_by": updated_by,
            # What the model actually said about this line, so a figure disputed
            # months later can be told apart from one a reviewer corrected. The
            # browser carries this across its own rewrites of the row
            # (saveTransactionsForReceipt), which is what keeps it comparable.
            "raw_extracted_data": t,
        })
    return rows


_RECEIPT_STORAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "pdf"}


def _validated_receipt_storage_path(receipt: dict) -> str:
    """Returns the canonical object path only when it belongs to this receipt.

    Storage reads use the service role, so RLS cannot protect this request. The
    path stored on the row must therefore be tied to the row's own tenant,
    batch, and receipt identifiers before any privileged download is attempted.
    """
    organization_id = str(receipt.get("organization_id") or "")
    batch_id = str(receipt.get("batch_id") or "")
    receipt_id = str(receipt.get("id") or "")
    file_path = receipt.get("file_path")
    if not all((organization_id, batch_id, receipt_id, isinstance(file_path, str))):
        raise RuntimeError("The stored receipt image path is invalid.")

    expected_prefix = f"{organization_id}/{batch_id}/{receipt_id}."
    extension = file_path[len(expected_prefix):].lower() if file_path.startswith(expected_prefix) else ""
    if extension not in _RECEIPT_STORAGE_EXTENSIONS:
        raise RuntimeError("The stored receipt image path does not belong to this receipt.")
    return file_path


async def _prepare_extraction(receipt: dict, user_id: Optional[str]) -> dict:
    """Reads one stored receipt and prepares the complete fenced-write payload."""
    receipt_id = receipt["id"]
    filename = receipt.get("filename") or "receipt"
    file_path = _validated_receipt_storage_path(receipt)

    # The image comes from storage, never from the request — by the time this
    # runs the browser that uploaded it may be long gone.
    async with httpx.AsyncClient(timeout=60) as client:
        obj = await client.get(
            f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{quote(file_path, safe='/')}",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
        )
    if obj.status_code != 200:
        raise RuntimeError(INTERRUPTED_NO_IMAGE_ERROR)

    raw_bytes = obj.content
    content_type = obj.headers.get("content-type") or "image/jpeg"
    if not content_type.startswith("image/") and content_type != "application/pdf":
        content_type = "image/jpeg"

    progress = extraction_progress()
    progress.step(
        _PROGRESS_IMAGE_READY,
        "image downloaded",
        f"{len(raw_bytes) / 1024:.0f} KB, {content_type}",
    )

    result = await run_extraction(raw_bytes, content_type, filename)

    error_msg = result.get("error")
    transactions = result.get("transactions") or []
    warnings = (result.get("verification") or {}).get("warnings") or []

    if error_msg or not transactions:
        return {
            "error": error_msg or DEFAULT_EXTRACTION_ERROR,
            "rows": [],
            "warnings": [],
            "raw_extraction": result,
            "has_signature": None,
        }

    rows = normalize_transaction_rows(
        transactions,
        receipt_id=receipt_id,
        batch_id=receipt["batch_id"],
        organization_id=receipt["organization_id"],
        updated_by=user_id or receipt.get("uploaded_by"),
    )
    progress.step(
        _PROGRESS_ROWS_READY,
        "rows prepared",
        f"{len(rows)} ledger {'line' if len(rows) == 1 else 'lines'}",
    )

    # Resolve each name against the organisation's real chart of accounts.
    # Only certain matches rewrite the extracted name; suggestions remain for a
    # person to confirm.
    #
    # Never allowed to fail the receipt. Matching is an enrichment step that runs
    # after the voucher has already been read, checked against its own जम्मा
    # totals, and turned into rows — and a failure here used to propagate out of
    # this function, so the queue worker marked the whole extraction Failed and
    # discarded transactions that were complete and correct. Observed with a
    # blank message, because httpx raises its timeouts with no text.
    if ledger_matching_ready:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                ledgers = await _load_org_ledgers(client, receipt["organization_id"])
        except Exception as err:
            # CancelledError is a BaseException and deliberately not caught here:
            # an extraction being cancelled must still unwind.
            log(f"⚠️ Could not load the chart of accounts: {_describe_error(err)}")
            warnings = warnings + [LEDGER_MATCHING_UNAVAILABLE_WARNING]
            progress.step(
                _PROGRESS_LEDGERS_DONE,
                "ledger matching unavailable",
                "the chart of accounts could not be loaded; rows left unmatched",
            )
        else:
            warnings = warnings + ledger_matching.apply_to_rows(rows, ledgers)
            progress.step(
                _PROGRESS_LEDGERS_DONE,
                "ledger matching applied",
                f"checked against {len(ledgers)} "
                f"{'ledger' if len(ledgers) == 1 else 'ledgers'}",
            )
    else:
        progress.step(
            _PROGRESS_LEDGERS_DONE,
            "ledger matching skipped",
            "not enabled for this database",
        )

    return {
        "error": None,
        "rows": rows,
        "warnings": warnings,
        "raw_extraction": result,
        "has_signature": result.get("has_signature"),
    }


async def _extract_and_store(receipt: dict, user_id: Optional[str]) -> None:
    """Compatibility persistence path for databases before migration 007."""
    receipt_id = receipt["id"]
    filename = receipt.get("filename") or "receipt"
    prepared = await _prepare_extraction(receipt, user_id)

    async with httpx.AsyncClient(timeout=60) as client:
        # Kept whatever happens: a failed reading is precisely the one worth
        # being able to look at afterwards. Gated on the same probe as claiming
        # because raw_extraction is the other receipts column migration 002 adds.
        audit = (
            {"raw_extraction": prepared["raw_extraction"]}
            if job_claiming_ready else {}
        )
        # Gated on their own probe, not on job_claiming_ready: these columns
        # arrive with migrations far later than 002, so a database can satisfy
        # that flag and still not have them.
        extraction_metadata = (
            {
                "has_signature": prepared.get("has_signature"),
                "extracted_by": user_id or receipt.get("uploaded_by"),
                # Set here rather than left to updated_at, which the touch
                # trigger moves on every later edit; a corrected voucher must
                # not look freshly extracted. The queue path sets this in its RPC.
                "extracted_at": _now(),
            }
            if receipt_extraction_metadata_ready else {}
        )

        if prepared["error"]:
            extraction_progress().failed(prepared["error"])
            await _patch_receipt(client, receipt_id, _finished({
                "status": "Failed",
                "error_message": prepared["error"],
                **({"has_signature": None} if receipt_extraction_metadata_ready else {}),
                "verification_warnings": [],
                **audit,
            }))
            log(f"❌ Extraction failed for {filename}: {prepared['error']}")
            return

        rows = prepared["rows"]
        extraction_progress().step(
            _PROGRESS_SAVING, "saving to the database", f"{len(rows)} rows"
        )

        # Replace rather than append, so a retry cannot leave the voucher with
        # the rows from a previous attempt still attached to it.
        await client.delete(
            f"{SUPABASE_URL}/rest/v1/transactions",
            headers=_svc_headers(),
            params={"receipt_id": f"eq.{receipt_id}"},
        )
        inserted = await client.post(
            f"{SUPABASE_URL}/rest/v1/transactions",
            headers=_svc_headers(),
            json=rows,
        )
        if inserted.status_code not in (200, 201, 204):
            raise RuntimeError(f"The extracted rows could not be saved: {inserted.text}")

        # Only now is the receipt Extracted. Flipping the status before the rows
        # are safely stored would let the app show a finished receipt that has
        # nothing behind it.
        await _patch_receipt(client, receipt_id, _finished({
            "status": "Extracted",
            "error_message": None,
            "verification_warnings": prepared["warnings"],
            **extraction_metadata,
            **audit,
        }))

    extraction_progress().step(
        _PROGRESS_STORED, "done", f"{len(rows)} transactions stored"
    )
    log(f"✅ Stored {len(rows)} transactions for {filename} (receipt {receipt_id})")


async def _load_org_ledgers(client: httpx.AsyncClient, organization_id: str) -> List[dict]:
    """The organisation's active chart of accounts, for matching against."""
    res = await client.get(
        f"{SUPABASE_URL}/rest/v1/ledgers",
        headers=_svc_headers(),
        params={
            "select": "id,name,aliases,is_active",
            "organization_id": f"eq.{organization_id}",
            "is_active": "is.true",
        },
    )
    if res.status_code != 200:
        # Matching is an improvement on the extracted name, not a precondition
        # for having one, so a failure here leaves the rows unmatched rather
        # than losing a voucher that was read perfectly well.
        log(f"⚠️ Could not load the chart of accounts: {res.text}")
        return []
    return res.json() or []


async def _heartbeat_queued_extraction(job: dict, lease_lost: asyncio.Event) -> None:
    """Extends both the singleton lease and PGMQ visibility while OCR runs."""
    async with httpx.AsyncClient(timeout=20) as client:
        while True:
            await asyncio.sleep(EXTRACTION_QUEUE_HEARTBEAT_SECONDS)
            try:
                if not await heartbeat_extraction_job(client, job):
                    lease_lost.set()
                    return
            except asyncio.CancelledError:
                raise
            except Exception as err:
                # A transport failure is not proof that the lease was lost. A
                # later heartbeat or the fenced final RPC settles ownership.
                log(f"⚠️ Could not heartbeat queued extraction: {_describe_error(err)}")


async def _record_queued_failure(
    job: dict, message: str, raw_extraction: Optional[dict] = None
) -> None:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            accepted = await fail_extraction_job(client, job, message, raw_extraction)
        if not accepted:
            log(
                f"ℹ️ Ignored stale failure for receipt {job.get('receipt_id')}; "
                "its extraction lease is now owned elsewhere."
            )
    except Exception as err:
        # Do not issue an unfenced receipt patch here. If the RPC outcome is
        # unknown, PGMQ visibility expiry safely makes the job available again.
        log(f"⚠️ Could not persist queued extraction failure: {_describe_error(err)}")


async def _run_queued_extraction_job(job: dict) -> None:
    """Runs one globally leased job and finalizes it only through its fence."""
    receipt_id = str(job.get("receipt_id") or "")
    filename = str(job.get("filename") or "receipt")
    required = (
        "receipt_id", "queue_message_id", "lease_token", "batch_id",
        "organization_id", "file_path",
    )
    if any(job.get(field) in (None, "") for field in required):
        log("⚠️ Supabase returned an incomplete queued extraction job; leaving it for retry.")
        return

    receipt = {
        "id": receipt_id,
        "batch_id": job["batch_id"],
        "organization_id": job["organization_id"],
        "filename": filename,
        "file_path": job["file_path"],
        "uploaded_by": job.get("uploaded_by"),
    }
    user_id = job.get("requested_by") or job.get("uploaded_by")
    progress = ExtractionProgress(receipt_id, filename)
    # Set before the tasks below are created: a task copies the context at
    # creation, so anything set afterwards would never reach _prepare_extraction.
    progress_token = _extraction_progress.set(progress)
    attempt = job.get("attempt_count")
    progress.step(
        _PROGRESS_CLAIMED,
        "claimed from the queue",
        f"attempt {attempt}" if attempt else "starting",
    )
    lease_lost = asyncio.Event()
    heartbeat = asyncio.create_task(_heartbeat_queued_extraction(job, lease_lost))
    extraction = asyncio.create_task(_prepare_extraction(receipt, user_id))
    lost_waiter = asyncio.create_task(lease_lost.wait())
    _jobs_in_flight.add(receipt_id)

    try:
        done, _pending = await asyncio.wait(
            {extraction, lost_waiter},
            timeout=EXTRACTION_TIMEOUT_SECONDS,
            return_when=asyncio.FIRST_COMPLETED,
        )

        if lost_waiter in done and lease_lost.is_set():
            extraction.cancel()
            await asyncio.gather(extraction, return_exceptions=True)
            progress.failed("its extraction lease was taken over by another worker")
            log(f"ℹ️ Stopped stale extraction for receipt {receipt_id} after losing its lease.")
            return

        if extraction not in done:
            # Cancellation reaches _run_blocking_provider_calls, which keeps
            # awaiting every already-started SDK thread. Do not fence-fail and
            # release the singleton until that cleanup is complete, otherwise
            # the next receipt could overlap the timed-out provider request.
            extraction.cancel()
            await asyncio.gather(extraction, return_exceptions=True)
            progress.failed(
                f"exceeded the {EXTRACTION_TIMEOUT_SECONDS}s extraction deadline"
            )
            await _record_queued_failure(
                job,
                "Extraction took too long and was stopped. Please try again.",
            )
            return

        try:
            prepared = extraction.result()
        except asyncio.CancelledError:
            raise
        except Exception as err:
            progress.failed(_describe_error(err))
            await _record_queued_failure(
                job,
                extraction_error_message("Extraction", err),
            )
            log(f"❌ Queued extraction for receipt {receipt_id} failed: {_describe_error(err)}")
            return

        if lease_lost.is_set():
            progress.failed("its extraction lease was taken over by another worker")
            return

        if prepared["error"]:
            progress.failed(prepared["error"])
            await _record_queued_failure(
                job,
                prepared["error"],
                prepared.get("raw_extraction"),
            )
            log(f"❌ Extraction failed for {filename}: {prepared['error']}")
            return

        progress.step(
            _PROGRESS_SAVING,
            "saving to the database",
            f"{len(prepared['rows'])} rows",
        )
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                accepted = await complete_extraction_job(client, job, prepared)
        except Exception as err:
            # Completion may have committed even if its response was lost. Never
            # turn that ambiguity into an unfenced failure; redelivery is safe.
            progress.failed(
                f"the save could not be confirmed, so the receipt will be retried: "
                f"{_describe_error(err)}"
            )
            log(f"⚠️ Could not confirm queued extraction completion: {_describe_error(err)}")
            return

        if accepted:
            progress.step(
                _PROGRESS_STORED,
                "done",
                f"{len(prepared['rows'])} transactions stored",
            )
            log(
                f"✅ Stored {len(prepared['rows'])} transactions for {filename} "
                f"(receipt {receipt_id})"
            )
        else:
            progress.failed(
                "result discarded; its extraction lease is now owned elsewhere"
            )
            log(
                f"ℹ️ Discarded stale result for receipt {receipt_id}; "
                "its extraction lease is now owned elsewhere."
            )
    except asyncio.CancelledError:
        extraction.cancel()
        await asyncio.gather(extraction, return_exceptions=True)
        progress.failed("the backend is shutting down; the receipt will be retried")
        raise
    finally:
        heartbeat.cancel()
        lost_waiter.cancel()
        await asyncio.gather(heartbeat, lost_waiter, return_exceptions=True)
        _jobs_in_flight.discard(receipt_id)
        # Reset rather than leave set: this consumer loops on to the next
        # receipt in the same task, and a stale reporter would label those lines
        # with the previous receipt's name.
        _extraction_progress.reset(progress_token)


async def consume_extraction_queue() -> None:
    """Claims and processes one durable job at a time for this process.

    Every backend replica runs a consumer, but the database singleton lease in
    migration 007 permits only one of them to receive a job at any moment.
    """
    if extraction_queue_ready is not True:
        return

    # A quarter of the silence threshold, so a slot that goes stale is noticed
    # within roughly one extra check rather than a whole threshold late.
    reclaim_interval = max(5.0, EXTRACTION_QUEUE_STALE_RECLAIM_SECONDS / 4)

    async with httpx.AsyncClient(timeout=30) as client:
        # Zero means the first pass always checks. A backend that has just come
        # back from a crash is precisely when the slot is most likely to be held
        # by the process it replaced, so that check must not wait an interval.
        next_reclaim_check = 0.0

        while True:
            # Runs before the claim, not after a failed one: the claim returns
            # empty while a dead worker still holds the slot, so checking first
            # is what lets the freed voucher start in this same pass.
            if time.monotonic() >= next_reclaim_check:
                next_reclaim_check = time.monotonic() + reclaim_interval
                try:
                    reclaimed = await reclaim_stale_extraction_job(client)
                except asyncio.CancelledError:
                    raise
                except Exception as err:
                    # Never fatal. Losing this check only costs recovery speed;
                    # the visibility timeout still returns the work eventually.
                    log(f"⚠️ Could not check for a stale extraction lease: {_describe_error(err)}")
                else:
                    if reclaimed:
                        log(
                            f"♻️ Reclaimed receipt {reclaimed.get('receipt_id')} from worker "
                            f"{reclaimed.get('worker_id')}, silent for "
                            f"{reclaimed.get('silent_for_seconds')}s. Requeued for extraction."
                        )

            try:
                job = await claim_next_extraction_job(client)
            except asyncio.CancelledError:
                raise
            except Exception as err:
                log(f"⚠️ Could not claim the next queued extraction: {_describe_error(err)}")
                await asyncio.sleep(EXTRACTION_QUEUE_POLL_SECONDS)
                continue

            if not job:
                await asyncio.sleep(EXTRACTION_QUEUE_POLL_SECONDS)
                continue
            await _run_queued_extraction_job(job)


async def wait_for_extraction_queue_schema() -> None:
    """Retries an indeterminate startup probe without failing open.

    A transient Supabase/network error must not select the legacy path on a
    database that already has the global queue. Once absence is positively
    confirmed, the old concurrency-one worker remains available for rollout.
    """
    # A known broken migration chain cannot become safe through reconnecting.
    # Keep extraction paused until the operator applies migration 002 and
    # restarts, which reruns the complete feature probe before any worker starts.
    if extraction_queue_configuration_error:
        return

    while extraction_queue_ready is None:
        await asyncio.sleep(max(2.0, EXTRACTION_QUEUE_POLL_SECONDS))
        await detect_schema_features()
        if extraction_queue_configuration_error:
            return

    if extraction_queue_ready is True:
        await consume_extraction_queue()
        return

    await resume_interrupted_extractions()
    await run_legacy_extraction_maintenance()


async def _run_extraction_job(receipt: dict, user_id: Optional[str]) -> None:
    receipt_id = receipt["id"]
    # Each of these runs as its own task, and a task gets its own copy of the
    # context, so several concurrent legacy extractions cannot overwrite one
    # another's reporter.
    progress = ExtractionProgress(receipt_id, receipt.get("filename") or "receipt")
    _extraction_progress.set(progress)
    try:
        # Queueing time is deliberately outside the timeout: waiting for a slot
        # is not the same as being stuck.
        async with _extraction_slot():
            progress.step(_PROGRESS_CLAIMED, "starting extraction")
            await asyncio.wait_for(
                _extract_and_store(receipt, user_id),
                timeout=EXTRACTION_TIMEOUT_SECONDS,
            )
    except asyncio.TimeoutError:
        progress.failed(
            f"exceeded the {EXTRACTION_TIMEOUT_SECONDS}s extraction deadline"
        )
        await _fail_receipt(
            receipt_id,
            "Extraction took too long and was stopped. Please try again.",
        )
    except Exception as err:
        progress.failed(_describe_error(err))
        await _fail_receipt(receipt_id, extraction_error_message("Extraction", err))
        log(f"❌ Extraction job for receipt {receipt_id} failed: {_describe_error(err)}")
    finally:
        _jobs_in_flight.discard(receipt_id)


async def _load_receipt_for_caller(receipt_id: str, caller: dict) -> dict:
    """Reads a receipt, refusing one the caller has no business touching.

    This runs with the service role, which bypasses row-level security, so the
    organisation check the policies would normally apply has to be made here.
    """
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/receipts",
            headers=_svc_headers(),
            params={"select": receipt_job_select(), "id": f"eq.{receipt_id}"},
        )
    rows = res.json() if res.status_code == 200 else []
    if not rows:
        raise HTTPException(status_code=404, detail="That receipt no longer exists.")

    receipt = rows[0]
    receipt["organization_id"] = (receipt.get("scan_batches") or {}).get("organization_id")
    if caller.get("role") != "Super Admin" and receipt["organization_id"] != caller.get("organization_id"):
        raise HTTPException(status_code=403, detail="You do not have access to that receipt.")
    return receipt


@app.post("/api/receipts/{receipt_id}/extract", status_code=202)
async def start_receipt_extraction(receipt_id: str, authorization: Optional[str] = Header(None)):
    """Starts extraction and returns immediately.

    The caller is not expected to wait: it should watch the receipt's status and
    is free to close the tab in the meantime.
    """
    if not supabase_admin_available:
        raise HTTPException(status_code=503, detail="Background extraction is not configured on this server.")

    caller = await resolve_caller(authorization)
    if extraction_queue_configuration_error:
        raise HTTPException(
            status_code=503,
            detail=extraction_queue_configuration_error,
        )
    receipt = await _load_receipt_for_caller(receipt_id, caller)

    # A completed receipt is already the desired outcome. Treat a repeated
    # request as idempotent instead of paying to read the same voucher again.
    if receipt.get("status") == "Extracted":
        return {"receipt_id": receipt_id, "status": "Extracted"}

    if extraction_queue_ready is None:
        raise HTTPException(
            status_code=503,
            detail="Extraction is temporarily paused while the durable queue reconnects.",
        )

    if extraction_queue_ready is True:
        if not receipt.get("file_path"):
            raise HTTPException(
                status_code=409,
                detail="The image is still uploading. Please try again in a moment.",
            )
        if not receipt.get("organization_id"):
            raise HTTPException(
                status_code=400,
                detail="That receipt's batch is not linked to an organisation.",
            )
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                queued = await enqueue_extraction_job(client, receipt_id, caller["id"])
        except (RuntimeError, httpx.HTTPError) as err:
            log(f"⚠️ Could not enqueue receipt {receipt_id}: {_describe_error(err)}")
            raise HTTPException(
                status_code=503,
                detail="The extraction queue is temporarily unavailable. Please try again.",
            )

        effective_status = (
            "Processing" if queued.get("status") == "Processing" else "Queued"
        )
        response = {
            "receipt_id": receipt_id,
            "status": effective_status,
            "detail": (
                "Already being extracted."
                if effective_status == "Processing"
                else "Already queued."
                if queued.get("already_queued") is True
                else "Queued for extraction."
            ),
        }
        if queued.get("queue_message_id") is not None:
            response["extraction_queue_message_id"] = queued["queue_message_id"]
        if queued.get("queued_at") is not None:
            response["extraction_queued_at"] = queued["queued_at"]
        return response

    # Already running here, or already running in another process whose claim is
    # still being refreshed. Either way the work is under way and starting it a
    # second time would only duplicate the vision-API bill.
    if receipt_id in _jobs_in_flight or _claim_is_live(receipt):
        return {"receipt_id": receipt_id, "status": "Processing", "detail": "Already being extracted."}

    if not receipt.get("file_path"):
        raise HTTPException(status_code=409, detail="The image is still uploading. Please try again in a moment.")
    if not receipt.get("organization_id"):
        raise HTTPException(status_code=400, detail="That receipt's batch is not linked to an organisation.")

    # Registered before the first await, so two requests arriving together find
    # each other rather than both getting past the check above.
    _jobs_in_flight.add(receipt_id)
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            won = await _claim_receipt(client, receipt_id, only_if_stale=False)
    except Exception:
        _jobs_in_flight.discard(receipt_id)
        raise
    if not won:
        _jobs_in_flight.discard(receipt_id)
        raise HTTPException(status_code=409, detail="That receipt could not be started. Please try again.")

    _spawn(_run_extraction_job(receipt, caller.get("id")))
    return {"receipt_id": receipt_id, "status": "Processing"}


async def resume_interrupted_extractions() -> None:
    """Restarts extractions that died with a previous server process.

    Only work whose claim has gone stale is taken over. That distinction is what
    makes it safe to run more than one of these processes: a receipt being
    extracted right now by a healthy instance has a claim that instance is still
    refreshing, so a booting neighbour reads it as taken and leaves it alone.
    """
    if not supabase_admin_available:
        return
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.get(
                f"{SUPABASE_URL}/rest/v1/receipts",
                headers=_svc_headers(),
                params={"select": receipt_job_select(), "status": "eq.Processing"},
            )
            if res.status_code != 200:
                log(f"⚠️ Could not check for interrupted extractions: {res.text}")
                return

            stranded = res.json() or []
            resumed = 0
            for receipt in stranded:
                receipt["organization_id"] = (receipt.get("scan_batches") or {}).get("organization_id")
                if receipt["id"] in _jobs_in_flight or _claim_is_live(receipt):
                    continue
                # Without an image or an organisation there is nothing to retry,
                # and leaving it Processing would strand it permanently.
                if not receipt.get("file_path") or not receipt["organization_id"]:
                    await _patch_receipt(client, receipt["id"], _finished({
                        "status": "Failed",
                        "error_message": INTERRUPTED_NO_IMAGE_ERROR,
                    }))
                    continue
                # The claim is what settles the race when two processes start at
                # once and both see the same stranded receipt.
                if not await _claim_receipt(client, receipt["id"], only_if_stale=True):
                    continue
                _jobs_in_flight.add(receipt["id"])
                _spawn(_run_extraction_job(receipt, receipt.get("uploaded_by")))
                resumed += 1

            if resumed:
                log(f"↻ Resuming {resumed} extraction(s) interrupted by a restart")
    except Exception as err:
        log(f"⚠️ Could not check for interrupted extractions: {_describe_error(err)}")


async def run_legacy_extraction_maintenance() -> None:
    """Keeps compatibility claims alive and periodically recovers stale work."""
    heartbeat = asyncio.create_task(refresh_extraction_claims())
    try:
        while True:
            await asyncio.sleep(CLAIM_HEARTBEAT_SECONDS)
            await resume_interrupted_extractions()
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
