"""Create reproducible release archives using only the Python standard library."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist'
metadata = json.loads((OUT / 'release-manifest.json').read_text(encoding='utf-8'))
version = metadata['version']
archives = []


def archive(directory, name):
    destination = OUT / name
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
        for file in sorted(directory.rglob('*')):
            if not file.is_file():
                continue
            entry = zipfile.ZipInfo(file.relative_to(directory).as_posix(), (2026, 11, 8, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            zipped.writestr(entry, file.read_bytes())
    with zipfile.ZipFile(destination) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError(f'Archive validation failed: {name}')
    archives.append(destination)


archive(OUT / 'full', f'ai-companion-shelf-{version}.zip')
for character in metadata['characters']:
    archive(OUT / 'characters' / character, f'companion-{character}-{version}.zip')
archive(ROOT / 'themes/white-dragon-lavender', f'white-dragon-lavender-{version}.zip')
(OUT / 'SHA256SUMS.txt').write_text(''.join(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n' for file in archives), encoding='utf-8')
print(f'Created and checked {len(archives)} ZIP archives.')
