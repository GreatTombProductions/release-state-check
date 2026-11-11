"""Compare a producer WCS window with a co-producer mirror (Zarr v3 over HTTPS).

Usage: python3 compare_mirror_window.py <wcs_window.tif>
Reads only the Zarr metadata and the shards the window touches. Anonymous.
"""
import sys
import numpy as np
import rasterio
import zarr

MIRROR = "https://data.source.coop/mindearth/wsf/World_WSF_20160701-20260101.zarr"

def main(path):
    with rasterio.open(path) as r:
        w = r.read(1)
        t = r.transform
    a = zarr.open_array(MIRROR + "/0/wsf_tracker", mode="r")
    grp = zarr.open_group(MIRROR, mode="r")
    print("mirror array", a.shape, a.dtype)
    px = abs(t.a)
    # Mirror origin from its own metadata when present, else the published transform.
    attrs = dict(grp.attrs)
    tr = attrs.get("spatial:transform")
    print("mirror spatial:transform", tr)
    left, top, mpx = tr[2], tr[5], tr[0]
    print("pixel size producer", px, "mirror", mpx)
    c0 = round((t.c - left) / mpx)
    r0 = round((top - t.f) / mpx)
    print("phase residual (px): col", (t.c - left) / mpx - c0, "row", (top - t.f) / mpx - r0)
    z = a[r0:r0 + w.shape[0], c0:c0 + w.shape[1]]
    eq = z.astype(np.int16) == w.astype(np.int16)
    print("window rows", r0, "cols", c0, "shape", z.shape)
    print("identical pixels", int(eq.sum()), "of", eq.size, "mismatch", int((~eq).sum()))
    v, c = np.unique(w, return_counts=True)
    print("producer value counts", dict(zip(v.tolist(), c.tolist())))

if __name__ == "__main__":
    main(sys.argv[1])
