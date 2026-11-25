"""Small document-order HTML tree shared by the funding and House catalogues."""
from html.parser import HTMLParser


class Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []
        self.parent = None
        self.segments = []

    def text(self):
        raw = "".join(segment.text() if isinstance(segment, Node) else segment for segment in self.segments)
        return " ".join(raw.split())

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()

    def find(self, pred):
        return next((n for n in self.walk() if pred(n)), None)

    def findall(self, pred):
        return [n for n in self.walk() if pred(n)]


class TreeParser(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root, self.stack = Node("root"), []
        self.stack.append(self.root)

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs); n.parent = self.stack[-1]; n.parent.children.append(n); n.parent.segments.append(n)
        if tag not in self.VOID: self.stack.append(n)

    def handle_startendtag(self, tag, attrs): self.handle_starttag(tag, attrs); self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]; return

    def handle_data(self, data): self.stack[-1].segments.append(data)


def tree(markup):
    p = TreeParser(); p.feed(markup); return p.root


def cls(node, name): return name in node.attrs.get("class", "").split()
