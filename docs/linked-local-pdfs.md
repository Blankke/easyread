# Linked local PDFs

Local PDFs can be referenced without creating a second PDF in the EasyRead
library. Folder and Zotero bulk imports expose a checkbox; the default remains
copying. Bulk imports prepare original pages without enabling translation.

```sh
easyread import /absolute/path/paper.pdf --link --no-translate
```

The Python API can create a catalog entry without preparing pages immediately:

```python
from pathlib import Path
from easyread.library.library import Library

library = Library(Path("/path/to/EasyRead/library"))
workspace, fresh = library.import_pdf_path(Path("/path/to/paper.pdf"), link=True)
original_pdf = workspace.source_pdf
```

`import_pdf_path(source, meta=None, *, link=False)` returns `(Workspace, bool)`.
PDF content determines the ID in both modes. Importing an existing ID never
changes its storage mode, paper content, notes, progress or item data. A linked
catalog entry without a page cache prepares that cache on its first reader open.
`source_pdf_path` in `paper.json` metadata stores the canonical external path;
the public reader URL remains `/p/<id>/source.pdf`.

Converting an existing copy is a separate, explicit operation:

```python
library.convert_pdf_to_link(workspace.id, Path("/path/to/paper.pdf"), remove_copy=True)
```

Conversion checks the external PDF's full SHA-256 against the saved digest and
the actual library copy before changing metadata. `remove_copy=True` is required
to remove an existing regular `source.pdf`; other saved data stays intact.
Targets inside the EasyRead library and symlinked library copies are rejected.
Conversion is idempotent for an already linked entry with the same content.

Bulk HTTP request (folder or Zotero source):

```json
{
  "source": "folder",
  "path": "/absolute/path/papers",
  "tags": true,
  "fetch": false,
  "link": true
}
```

Send this JSON to `POST /api/migrate/start` with the normal `X-Token` header.
`link` defaults to false. Linked mode accepts local readable PDF files only;
network fetching cannot be combined with it. Entries without a local PDF are
skipped, and per-file errors are recorded in the bulk result.

Keep original PDFs at their recorded paths. A missing or unreadable linked PDF
reports its path and asks for the original file to be restored there. Generated
pages, extracts and figures remain inside EasyRead. Trash, restore, purge and
cloud-library cleanup operate on EasyRead's files only. Cloud-library copy and
merge preserve the external-path metadata without following or materializing
the original PDF; another computer must have access to the same path. This is
a local reference, not a portable bundle or an automatic relinking system.
