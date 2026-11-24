"""Project the official S-5 XML exports or verify a replayed brief against them."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(element, *names):
    result = {name: element.findtext(name) for name in names}
    require(all(result.values()), f"Missing required fields on {element.tag}: {names}")
    return result


def source_file(path, url):
    data = path.read_bytes()
    return ET.fromstring(data), {"source": url, "sha256": hashlib.sha256(data).hexdigest()}


def extract(legisinfo_path, vote_path):
    root, info = source_file(legisinfo_path, "https://www.parl.ca/legisinfo/en/bill/44-1/s-5/xml")
    bills = root.findall("Bill")
    require(len(bills) == 1, "Expected one LEGISinfo bill")
    bill = bills[0]
    identity = fields(bill, "Id", "ParliamentNumber", "SessionNumber", "NumberCode")
    require(list(identity.values()) == ["11558854", "44", "1", "S-5"], "Unexpected bill identity")
    publications = [fields(row, "PublicationId", "PublicationTypeId", "PublicationTypeNameEn", "PublicationTypeNameFr")
                    for row in bill.findall("Publications")]
    stages = []
    for stage in bill.findall("BillStages/*"):
        for event in stage.findall("SignificantEvents"):
            stages.append({**fields(stage, "BillStageId", "ChamberOrganizationId"),
                           **fields(event, "EventTypeId", "EventNameEn", "EventNameFr", "EventDateTime")})
    message = bill.find("BillStages/InterChamberMessages[MeetingNumber='133']")
    require(message is not None, "Missing Senate concurrence")
    legisinfo = {**info, "bill": identity, "billId": identity["Id"], "stages": stages,
                 "publications": publications,
                 "concurrence": fields(message, "EventNameEn", "EventNameFr", "Date", "MeetingNumber", "ChamberOrganizationId")}

    root, provenance = source_file(vote_path, "https://www.ourcommons.ca/Members/en/votes/44/1/338/xml")
    details = bill.find("HouseVoteDetails[DivisionNumber='338']")
    require(details is not None and "S-5" in details.findtext("DivisionSubjectEn", ""), "Missing bill division")
    participants = root.findall("VoteParticipant")
    require(participants, "Empty recorded division")
    counts, people = Counter(), set()
    stamp = bill.findtext("PassedHouseThirdReadingDateTime")
    flags = {"IsVoteYea": "yeas", "IsVoteNay": "nays", "IsVotePaired": "paired"}
    for person in participants:
        require(all(person.findtext(k) == v for k, v in {
            "ParliamentNumber": "44", "SessionNumber": "1", "DecisionDivisionNumber": "338",
            "DecisionResultName": details.findtext("DecisionResultNameEn"), "DecisionEventDateTime": stamp,
        }.items()), "Unexpected vote identity, time or result")
        person_id = person.findtext("PersonId")
        require(person_id and person_id not in people, "Duplicate or missing participant ID")
        people.add(person_id)
        cast = [value for key, value in flags.items() if person.findtext(key) == "true"]
        require(len(cast) == 1, "Expected one vote per participant")
        counts[cast[0]] += 1
    expected = {"yeas": "DivisionVotesYeas", "nays": "DivisionVotesNays", "paired": "DivisionVotePaired"}
    for key, field in expected.items():
        require(counts[key] == int(details.findtext(field)), f"House and LEGISinfo tallies differ: {key}")
    vote = {**provenance, **fields(participants[0], "ParliamentNumber", "SessionNumber"), "DivisionNumber": "338",
            "DecisionEventDateTime": stamp, "DecisionResultName": details.findtext("DecisionResultNameEn"),
            **fields(details, "DivisionSubjectEn", "DivisionSubjectFr"), "counts": {k: counts[k] for k in expected}}
    return legisinfo, vote


def verify(brief, info, vote):
    require(brief["complete"] and brief["bill"]["legisinfoId"] == int(info["billId"]), "Unexpected bill or partial brief")
    records = brief["records"]
    versions = {r["sourceId"] for r in records if r["kind"] == "version"}
    require(versions == {row["PublicationId"] for row in info["publications"]}, "Published versions differ")
    events = set()
    for row in info["stages"]:
        chamber = "house" if row["ChamberOrganizationId"] == "1" else "senate"
        if row["EventTypeId"] == "60149":
            chamber = "parliament"
        events.add((chamber, row["EventTypeId"], row["EventDateTime"][:10]))
    stamp = info["concurrence"]["Date"]
    events.add(("senate", stamp, stamp[:10]))
    actual = {(r["chamber"], r["sourceId"], r["date"]) for r in records if r["kind"] == "stage"}
    require(actual == events, f"Stage history differs: {actual.symmetric_difference(events)}")
    division = next(r for r in records if r["kind"] == "vote" and r["sourceId"] == vote["DivisionNumber"])
    require(division["date"] == vote["DecisionEventDateTime"][:10], "Division date differs")
    result = {"Agreed To": "agreed", "Negatived": "negatived"}[vote["DecisionResultName"]]
    require(division["tally"] == {**vote["counts"], "result": result}, "Vote tally differs")
    return {"billId": info["billId"], "publications": len(versions), "stageEvents": len(events),
            "division": division["sourceId"], "participants": sum(vote["counts"].values()), "tally": division["tally"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("legisinfo_xml", type=Path)
    parser.add_argument("vote_xml", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--verify", metavar="BRIEF", type=Path)
    mode.add_argument("--project", metavar="DIRECTORY", type=Path, help="Create a new directory for the two compact inputs")
    args = parser.parse_args()
    info, vote = extract(args.legisinfo_xml, args.vote_xml)
    if args.verify:
        print(json.dumps(verify(json.loads(args.verify.read_text()), info, vote)))
    else:
        args.project.mkdir()
        for filename, data in (("legisinfo.json", info), ("vote.json", vote)):
            (args.project / filename).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
