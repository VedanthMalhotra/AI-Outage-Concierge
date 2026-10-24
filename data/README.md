# Challenge data

Datasets supplied for the AEP HackOHI/O 2026 AI Outage Concierge challenge.

## Inventory

| File | Contents | Compressed size |
| --- | --- | --- |
| `raw/Data1.zip` | GIS shapefiles for customers, poles, primary lines, fuse banks, damage assessments, ambulance services, fire stations, and hospitals | 18.3 MiB |
| `raw/Data2.zip` | GIS shapefiles for secondary lines, transformers, switches, and recloser banks | 12.1 MiB |
| `raw/matched_upstream.zip` | `matched_upstream.txt`: upstream/topology relationships described in the challenge | 1.4 MiB |

`Install_Labor_HackOHIO.xlsx` is the supplied installation/labor reference workbook. The challenge brief and structure diagrams are in [`../docs/`](../docs/).

## Extract locally

From the repository root, using `unzip`:

```bash
mkdir -p data/extracted/Data1 data/extracted/Data2 data/extracted/matched_upstream
unzip -n data/raw/Data1.zip -d data/extracted/Data1
unzip -n data/raw/Data2.zip -d data/extracted/Data2
unzip -n data/raw/matched_upstream.zip -d data/extracted/matched_upstream
```

The `-n` option avoids overwriting existing files. Extracted files are ignored by Git.

Keep each shapefile's `.shp`, `.shx`, `.dbf`, `.prj`, and other companion files together.
