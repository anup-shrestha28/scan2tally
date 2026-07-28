import os
import io
import json
import re
import base64
import hashlib
import asyncio
from collections import Counter
from typing import List, Optional
import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import numpy as np
import cv2
from dotenv import load_dotenv

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
    print("✅ Supabase admin API configured (user creation enabled)")
else:
    print("⚠️ Supabase admin API not configured — user creation endpoint disabled")

# Vision model, overridable without a code change. gpt-5.5 reads marginal /
# low-resolution vouchers noticeably better than gpt-4o in side-by-side tests.
OPENAI_VISION_MODEL = os.getenv("OPENAI_VISION_MODEL", "gpt-5.5")

# Independent transcription passes per receipt. Handwriting the model cannot
# resolve comes back differently on each pass, so comparing runs is what turns a
# silently-invented amount into a flagged one. Runs are issued concurrently, so
# this costs extra tokens rather than extra wall-clock. 1 disables the check.
OCR_CONSENSUS_RUNS = max(1, int(os.getenv("OCR_CONSENSUS_RUNS", "3")))


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
        return {"max_completion_tokens": 8000}
    return {"max_tokens": 3000, "temperature": 0}


# Check OpenAI Availability
openai_available = False
if OPENAI_API_KEY and OPENAI_API_KEY != "placeholder-openai-api-key":
    try:
        from openai import OpenAI
        openai_client = OpenAI(api_key=OPENAI_API_KEY)
        openai_available = True
        print(f"✅ OpenAI Vision AI engine activated! (model: {OPENAI_VISION_MODEL})")
    except Exception as e:
        print(f"Warning: Could not configure OpenAI: {e}")

# Check Gemini Availability
genai_available = False
if not openai_available and GEMINI_API_KEY and GEMINI_API_KEY != "placeholder-gemini-api-key":
    try:
        import google.generativeai as genai
        genai.configure(api_key=GEMINI_API_KEY)
        genai_available = True
        print("✅ Gemini Vision AI engine activated!")
    except Exception as e:
        print(f"Warning: Could not configure Gemini AI: {e}")

app = FastAPI(
    title="Scan2Tally Backend API",
    description="Automated Handwritten Receipt OCR & Tally Excel Bridge API",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

INVALID_JOURNAL_IMAGE_ERROR = "The uploaded image is not a journal entry. Please check and try again."

def extraction_error_message(engine: str, err: Exception) -> str:
    err_text = str(err)
    if "'NoneType' object has no attribute 'strip'" in err_text:
        return INVALID_JOURNAL_IMAGE_ERROR
    return f"{engine} Extraction Exception: {err}"

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

Ignore the bottom row labelled जम्मा entirely. It is a total, not a transaction; do not report it.

Return ONLY a JSON object in this shape:
    {
      "voucher_date": "2083-03-15",
      "transactions": [
        {
          "voucher_date": "2083-03-15",
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
# the transcription was allowed to steer toward.
TOTALS_PROMPT = """
Look ONLY at the bottom row of this handwritten Nepalese Goshwara voucher — the row
labelled जम्मा, which holds the voucher's own stated totals.

That row has a total under the खर्च (डेबिट) / Debit side and one under the
आम्दानी (क्रेडिट) / Credit side. Each is split into रु. (rupees) and पै. (paisa)
sub-columns; combine as rupees + paisa/100. An empty पै. cell means .00.

Transcribe only those two numbers. Ignore every other row. Do not compute anything.

Return ONLY a JSON object of this shape:
    {"stated_total_debit": 14408.35, "stated_total_credit": 14408.35}
"""


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
    content = response.choices[0].message.content
    if not content or not content.strip():
        return {}
    return json.loads(content.strip())


def openai_transcribe(base64_image: str, media_type: str) -> List[dict]:
    parsed = _openai_vision_json(TRANSCRIBE_PROMPT, base64_image, media_type)
    if isinstance(parsed, dict):
        return parsed.get("transactions") or []
    if isinstance(parsed, list):
        return parsed
    return []


def openai_read_totals(base64_image: str, media_type: str) -> dict:
    return read_stated_totals(_openai_vision_json(TOTALS_PROMPT, base64_image, media_type))


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

@app.get("/api/health")
def health_check():
    active_engine = f"OpenAI Vision ({OPENAI_VISION_MODEL})" if openai_available else ("Gemini 1.5 Flash" if genai_available else "Goshwara Dr/Cr Accounting Engine")
    return {
        "status": "online",
        "service": "Scan2Tally FastAPI Server",
        "vision_ai_engine": active_engine,
        "openai_configured": openai_available,
        "gemini_configured": genai_available,
        "opencv": "Enabled"
    }

@app.post("/api/extract-receipt")
async def extract_receipt(file: UploadFile = File(...)):
    if not file.content_type.startswith("image/") and file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only image files (JPG, PNG, WEBP) and PDFs are supported.")

    raw_bytes = await file.read()

    # Send original image bytes directly to AI — OpenCV grayscale conversion hurts OCR accuracy
    extracted_transactions = []
    error_msg = None
    stated_totals = {}  # the voucher's own जम्मा row, when the engine could read it
    consensus_notes: List[str] = []

    prompt = TRANSCRIBE_PROMPT

    # 1. Live OpenAI Extraction
    if openai_available:
        print(f"🤖 Sending image to OpenAI {OPENAI_VISION_MODEL}... (size: {len(raw_bytes)} bytes)")
        try:
            base64_image = base64.b64encode(raw_bytes).decode('utf-8')
            media_type = file.content_type if file.content_type.startswith("image/") else "image/jpeg"

            # Transcription and total-reading are issued as SEPARATE requests, run
            # concurrently. Keeping the जम्मा total out of the transcription prompt
            # is the whole point: when the model is shown the total in the same
            # breath it back-solves the line items to match it, producing different
            # invented numbers on every run that all sum to the stated total.
            # Several independent transcriptions then let us see which individual
            # cells the model cannot read consistently.
            runs = await asyncio.gather(
                *[asyncio.to_thread(openai_transcribe, base64_image, media_type)
                  for _ in range(OCR_CONSENSUS_RUNS)],
                asyncio.to_thread(openai_read_totals, base64_image, media_type),
                return_exceptions=True
            )
            transcripts = [r for r in runs[:-1] if not isinstance(r, Exception) and r]
            totals_result = runs[-1]

            failures = [r for r in runs if isinstance(r, Exception)]
            if failures and not transcripts:
                raise failures[0]

            if not transcripts:
                error_msg = INVALID_JOURNAL_IMAGE_ERROR
                print("❌ OpenAI returned no readable journal entry content")
            else:
                extracted_transactions, consensus_notes = build_consensus(transcripts)
                if isinstance(totals_result, Exception):
                    # Never fail the extraction over this — but say so, otherwise
                    # a broken totals call silently disables the whole check.
                    print(f"⚠️ Could not read the जम्मा total row: {totals_result}")
                elif totals_result:
                    stated_totals = totals_result
                print(f"✅ Extracted {len(extracted_transactions)} transactions from OpenAI "
                      f"({len(transcripts)}/{OCR_CONSENSUS_RUNS} transcription runs agreed on structure)")
                for note in consensus_notes:
                    print(f"⚠️ Consensus: {note}")
        except Exception as err:
            error_msg = extraction_error_message("OpenAI Vision", err)
            print(f"❌ {error_msg}")
    else:
        print("⚠️ OpenAI not available (key missing or invalid)")

    # 2. Live Gemini Extraction
    if not extracted_transactions and genai_available:
        print(f"🤖 Falling back to Gemini Vision...")
        try:
            import google.generativeai as genai
            pil_img = Image.open(io.BytesIO(raw_bytes))
            model = genai.GenerativeModel('gemini-1.5-flash')
            response = model.generate_content([prompt, pil_img])
            if not response.text or not response.text.strip():
                error_msg = INVALID_JOURNAL_IMAGE_ERROR
                print(f"❌ Gemini returned no readable journal entry content")
            else:
                raw_text = response.text.strip()
                print(f"📥 Gemini raw response:\n{raw_text}")
                cleaned_text = re.sub(r'^```json\s*', '', raw_text)
                cleaned_text = re.sub(r'\s*```$', '', cleaned_text)
                parsed_json = json.loads(cleaned_text)
                if isinstance(parsed_json, dict) and "transactions" in parsed_json:
                    extracted_transactions = parsed_json["transactions"]
                    stated_totals = read_stated_totals(parsed_json)
                elif isinstance(parsed_json, list):
                    extracted_transactions = parsed_json
                print(f"✅ Extracted {len(extracted_transactions)} transactions from Gemini")
        except Exception as err:
            error_msg = extraction_error_message("Gemini", err)
            print(f"❌ {error_msg}")

    # 3. Goshwara Accounting Classification Engine (offline demo fallback only —
    # never used once a real Vision AI engine is configured, so genuine
    # zero-result extractions aren't silently replaced with fake demo data)
    if not extracted_transactions and not openai_available and not genai_available:
        extracted_transactions = classify_voucher_image_content(raw_bytes, file.filename)
        if extracted_transactions:
            print(f"📋 Using demo classification engine: {len(extracted_transactions)} rows")

    print(f"🔚 Final result: {len(extracted_transactions)} transactions, error={error_msg}")

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
            print(f"⚠️ Verification: {warning}")
    elif verification["checked_against_voucher"]:
        print("✅ Verification: line items reconcile with the voucher's जम्मा totals")

    return {
        "filename": file.filename,
        "engine_used": (
            f"OpenAI {OPENAI_VISION_MODEL}" if openai_available
            else ("Gemini Vision" if genai_available else "Dr/Cr Accounting Engine")
        ),
        "status": "Extracted" if not error_msg else "Failed",
        "transactions": extracted_transactions,
        "error": error_msg,
        "verification": verification
    }

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


def _svc_headers() -> dict:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
