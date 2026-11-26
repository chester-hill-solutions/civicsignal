"""Validate federal bulk CSV structure while streaming the publisher's original rows."""
import csv


def scan(stream, series, nil=False, *, on_row=None):
    reader = csv.reader(stream, strict=True)
    fields = next(reader, [])
    if not fields or not all(fields) or len(set(fields)) != len(fields):
        raise ValueError("Missing or duplicate CSV headers")
    required = {"official-titles": {"Legal title", "Appellation légale", "Applied title", "Titre d'usage"},
                "service-inventory": {"service_id", "fiscal_yr", "service_name_en", "service_name_fr"},
                "grant-awards": {"owner_org", "fiscal_year", "quarter"} if nil else {"owner_org", "ref_number", "agreement_value"},
                "ati-summaries": {"owner_org", "year", "month"} if nil else {"owner_org", "request_number", "summary_en", "summary_fr"}}[series]
    if not required.issubset(fields):
        raise ValueError(f"Missing published fields: {sorted(required - set(fields))}")
    rows = 0
    for row in reader:
        if not row:
            continue
        if len(row) != len(fields):
            raise ValueError(f"CSV record {rows + 1} has {len(row)} values for {len(fields)} headers")
        if on_row is not None:
            on_row(row)
        rows += 1
    if not rows and not nil:
        raise ValueError("Published CSV contains no records")
    return fields, rows
