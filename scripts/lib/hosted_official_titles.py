"""Read the private weekly register's last complete titles publication for the institution report."""
import io
import json

from .federal_bulk_csv import scan
from .hosted_federal_bulk import complete_run, get_object, require, verified

PREFIX = 'weekly/official-titles'
DATASET = '83320390-7715-43bc-a281-2049bf5d4232'


def read_complete_titles(read=get_object):
    run, resources, receipt = complete_run(read, 'official-titles', DATASET, 8192)
    resource, = resources
    require(run['resource'] == resource, 'Hosted titles CSV differs from its verified catalogue')
    source, records = run['source'], run['records']
    original = verified(read, source, f"{PREFIX}/sources/{source['sha256']}.csv", 512 * 1024)
    stored = json.loads(verified(read, records, f"{PREFIX}/records/{records['sha256']}.json", 2 * 1024 * 1024))
    rows = []
    with io.TextIOWrapper(io.BytesIO(original), encoding='utf-8-sig', newline='') as stream:
        fields, count = scan(stream, 'official-titles', on_row=rows.append)
    require(type(run['rows']) is int and run['rows'] == count and stored == {'schemaVersion': 1, 'fields': fields, 'rows': rows},
            'Hosted titles records differ from the archived CSV')
    provenance = {'series': 'official-titles', 'url': resource['url'], 'sha256': source['sha256'],
                  'hostedReceipt': {**receipt, 'recordsSha256': records['sha256']}}
    return resource['resourceId'], provenance, [dict(zip(fields, row, strict=True)) for row in rows]
