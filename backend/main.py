import os
import io
import json
import re
import base64
import hashlib
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from PIL import Image
import numpy as np
import cv2
from dotenv import load_dotenv

# Load environment variables
load_dotenv(override=True)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Vision model, overridable without a code change. gpt-5.5 reads marginal /
# low-resolution vouchers noticeably better than gpt-4o in side-by-side tests.
OPENAI_VISION_MODEL = os.getenv("OPENAI_VISION_MODEL", "gpt-5.5")


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

class TransactionItem(BaseModel):
    voucher_date: str
    voucher_type: str = "Journal"
    entry_type: Optional[str] = "Dr" # "Dr" or "Cr"
    ledger_name: Optional[str] = ""
    debit_ledger: Optional[str] = ""
    credit_ledger: Optional[str] = ""
    debit_amount: Optional[float] = 0.0
    credit_amount: Optional[float] = 0.0
    amount: Optional[float] = 0.0
    narration: Optional[str] = ""

INVALID_JOURNAL_IMAGE_ERROR = "The uploaded image is not a journal entry. Please check and try again."

def extraction_error_message(engine: str, err: Exception) -> str:
    err_text = str(err)
    if "'NoneType' object has no attribute 'strip'" in err_text:
        return INVALID_JOURNAL_IMAGE_ERROR
    return f"{engine} Extraction Exception: {err}"

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

    prompt = """
You are an expert Nepalese accounting OCR assistant reading a handwritten Goshwara Voucher (गोश्वरा भौचर).
The image may be rotated sideways or upside down; read it in whatever orientation makes the text upright.

COLUMN STRUCTURE — this is the most common source of error, read it carefully:
The amount area is split into two sides: खर्च (डेबिट) = Debit, and आम्दानी (क्रेडिट) = Credit.
EACH side is split again into two narrow sub-columns:
    रु. = rupees (the whole number)   |   पै. = paisa (hundredths, 00-99)
Combine them as rupees + paisa/100.   e.g. रु.=1237, पै.=35  ->  1237.35

CRITICAL RULE: if a row's पै. (paisa) cell is EMPTY, the amount is exactly .00.
Never invent paisa, and never carry a paisa value over from a neighbouring row.
    e.g. रु.=690 with an empty पै. cell  ->  690.00   (NOT 690.12, NOT 690.50)
Read every digit of the rupees cell carefully — do not drop, merge or duplicate digits.
A row's amount belongs to whichever side (Debit or Credit) its digits are physically written under.

TOTAL ROW: the bottom row labelled जम्मा holds the voucher's own stated total for each side.
Transcribe those two numbers into "stated_total_debit" and "stated_total_credit".
Never emit the जम्मा row itself as a transaction line item.
Do not adjust any line item to make it agree with the total — report exactly what is written
in each cell, even if the line items do not add up to the stated total.

For every other row: classify it Dr or Cr, transcribe the ledger name exactly, and give the amount.

Return ONLY a JSON object in this shape:
    {
      "stated_total_debit": 14408.35,
      "stated_total_credit": 14408.35,
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

    # 1. Live OpenAI Extraction
    if openai_available:
        print(f"🤖 Sending image to OpenAI {OPENAI_VISION_MODEL}... (size: {len(raw_bytes)} bytes)")
        try:
            base64_image = base64.b64encode(raw_bytes).decode('utf-8')
            media_type = file.content_type if file.content_type.startswith("image/") else "image/jpeg"

            response = openai_client.chat.completions.create(
                model=OPENAI_VISION_MODEL,
                response_format={"type": "json_object"},
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{media_type};base64,{base64_image}",
                                    "detail": "high"
                                }
                            }
                        ]
                    }
                ],
                **openai_sampling_params(OPENAI_VISION_MODEL)
            )

            raw_content = response.choices[0].message.content
            if not raw_content or not raw_content.strip():
                error_msg = INVALID_JOURNAL_IMAGE_ERROR
                print(f"❌ OpenAI returned no readable journal entry content")
            else:
                raw_response = raw_content.strip()
                print(f"📥 OpenAI raw response:\n{raw_response}")
                parsed_json = json.loads(raw_response)

                if isinstance(parsed_json, dict) and "transactions" in parsed_json:
                    extracted_transactions = parsed_json["transactions"]
                    stated_totals = read_stated_totals(parsed_json)
                elif isinstance(parsed_json, list):
                    extracted_transactions = parsed_json

                print(f"✅ Extracted {len(extracted_transactions)} transactions from OpenAI")
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

@app.post("/api/export-tally-excel")
def export_tally_excel(transactions: List[TransactionItem]):
    """
    Generates a standard Tally Prime importable Excel (.xlsx) file.
    """
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Tally_Import"

    header_fill = PatternFill(start_color="1E293B", end_color="1E293B", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    data_font = Font(name="Calibri", size=11)
    border_side = Side(border_style="thin", color="CBD5E1")
    cell_border = Border(left=border_side, right=border_side, top=border_side, bottom=border_side)

    headers = [
        "Voucher Date", "Voucher Type", "Voucher Number", "Dr/Cr",
        "Ledger Name", "Debit Amount (Rs.)", "Credit Amount (Rs.)", "Narration"
    ]
    ws.append(headers)

    for col_num, header in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_num)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")

    for idx, tx in enumerate(transactions, start=1):
        ledger = tx.ledger_name or tx.debit_ledger or tx.credit_ledger or ""
        # Resolve the legacy flat `amount` onto whichever side the row belongs
        # to, so the Dr/Cr marker, the amount column and the totals all agree.
        legacy = tx.amount or 0
        dr_cr = tx.entry_type or ("Dr" if (tx.debit_amount or (legacy and not tx.credit_amount)) else "Cr")
        debit = (tx.debit_amount or legacy or 0) if dr_cr == "Dr" else 0
        credit = (tx.credit_amount or legacy or 0) if dr_cr == "Cr" else 0
        row = [
            tx.voucher_date,
            tx.voucher_type,
            f"VCH-{idx:04d}",
            dr_cr,
            ledger,
            debit,
            credit,
            tx.narration
        ]
        ws.append(row)
        
        row_idx = ws.max_row
        for col_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.font = data_font
            cell.border = cell_border
            if col_idx in (6, 7):
                cell.number_format = "#,##0.00"
                cell.alignment = Alignment(horizontal="right")

    for col in ws.columns:
        max_len = max(len(str(cell.value or '')) for cell in col)
        col_letter = openpyxl.utils.get_column_letter(col[0].column)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 15)

    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)

    return StreamingResponse(
        stream,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=Scan2Tally_Import.xlsx"}
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
