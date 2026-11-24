"""Extract ordered speaker turns from official committee proceedings HTML."""
from html.parser import HTMLParser
import re
from urllib.parse import unquote, urlsplit


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.blocks = []
        self.current = None
        self.capture_speaker = 0
        self.content_depth = 0
        self.paragraph_depth = 0
        self.ordinal = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set((attrs.get('class') or '').split())
        self.stack.append((tag, attrs, classes))
        if attrs.get('id') in ('docContent','content-viewer-document') or 'publication-container-content' in classes:
            if not self.content_depth:
                self.content_depth = len(self.stack)
        if self.content_depth and tag in ('p','li','h2','h3','h4') and self.current is None:
            self.ordinal += 1
            self.current = {'text':'','location':attrs.get('id') or f'paragraph-{self.ordinal}',
                            'speaker':None,'affiliation':None,'generic':True}
            self.paragraph_depth = len(self.stack)
        if 'paratext' in classes:
            self.current = {'text': '', 'location': attrs.get('id'), 'speaker': None, 'affiliation': None}
        if self.current is not None and tag == 'a' and attrs.get('name'):
            self.current['location'] = attrs['name']
        if tag == 'b' and self.current is not None and self.current.get('generic') and not self.current.get('speaker') and not self.current['text'].strip():
            self.capture_speaker += 1
        if 'personSpeaking' in classes and self.current is not None:
            self.capture_speaker += 1

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                _, _, classes = self.stack[index]
                del self.stack[index:]
                if 'personSpeaking' in classes and self.capture_speaker:
                    self.capture_speaker -= 1
                if tag == 'b' and self.capture_speaker:
                    self.capture_speaker -= 1
                if 'paratext' in classes and self.current is not None:
                    self.current['text'] = _clean(self.current['text'])
                    if self.current['text']:
                        self.blocks.append(self.current)
                    self.current = None
                if self.content_depth and tag in ('p','li','h2','h3','h4') and self.current is not None and self.current.get('generic'):
                    self.current['text'] = _clean(self.current['text'])
                    if self.current['text']:
                        self.blocks.append(self.current)
                    self.current = None
                if self.content_depth and len(self.stack) < self.content_depth:
                    self.content_depth = 0
                break

    def handle_data(self, data):
        if self.current is None:
            return
        if self.capture_speaker:
            self.current['speaker'] = (self.current.get('speaker') or '') + data
        self.current['text'] += data


def _clean(value):
    return re.sub(r'\s+', ' ', value or '').strip(' \t\r\n:')


def extract_proceedings(body: bytes, url: str, language: str) -> list[dict]:
    """Return ordered House transcript turns; unsupported markup returns [].

    House DocumentViewer evidence identifies paragraphs with stable Para IDs and
    explicit speaker headings with ``personSpeaking``. The heading is retained
    on the turn and on following paragraphs until the next explicit heading.
    Senate HTML uses its own publication markup; turns are emitted only when
    speaker-labelled blocks are present, avoiding fabricated speaker attribution.
    """
    if language not in ('en', 'fr'):
        raise ValueError('language must be en or fr')
    text = body.decode('utf-8-sig', errors='replace')
    source = urlsplit(url)
    house_evidence = source.hostname in {
        'www.ourcommons.ca', 'www.noscommunes.ca', 'www.parl.ca'
    } and bool(re.fullmatch(
        r'/documentviewer/(?:en|fr)/45-1/[^/]+/(?:meeting|reunion)-\d+/(?:evidence|temoignages)/?',
        unquote(source.path), re.I))
    senate_evidence = bool(re.search(r'sencanada\.ca/.*/(?:\d+ev-\d+-[ef]|\d+-[ef])$',url,re.I))
    if senate_evidence and re.search(r'sencanada\.ca/.*/\d+-[ef]$',url,re.I):
        senate_evidence = bool('content-viewer-document' in text.lower() and re.search(r'\b(?:evidence|t[ée]moignages)\b',text,re.I))
    if not (house_evidence or senate_evidence):
        return []
    parser = _Text()
    parser.feed(text)
    uses_house_paragraphs = house_evidence and any(not b.get('generic') for b in parser.blocks)
    turns = []
    speaker = affiliation = None
    for block in parser.blocks:
        raw_speaker = block['speaker'] or ''
        candidate = _clean(raw_speaker) if re.search(r'[:：]\s*$',raw_speaker) else None
        if candidate:
            # Keep the source's label verbatim and reset affiliation. The
            # publication does not identify an affiliation field separately.
            speaker = candidate
            affiliation = None
        content = block['text']
        if candidate and content.startswith(candidate):
            content = content[len(candidate):].lstrip(' :：')
        if uses_house_paragraphs and block.get('generic'):
            continue
        if block.get('generic') and not candidate and speaker is None:
            continue
        if block.get('generic') and raw_speaker and not candidate:
            continue
        if not content.strip():
            continue
        location = block['location']
        if location and location.startswith('Para'):
            location = location[4:]
        turns.append({'text': content, 'location': location, 'speaker': speaker, 'affiliation': affiliation})
    if not turns and re.search(r'(?:sencanada\.ca/.*/(?:content/sen/committee|committee)|ourcommons\.ca/documentviewer)',url,re.I):
        # Keep the absence of a transcript distinguishable from parse errors;
        # callers can record an empty extraction against the original URL.
        return []
    return turns
