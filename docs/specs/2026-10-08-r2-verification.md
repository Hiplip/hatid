# R2 live verification — hatid v1

- **Date:** 2026-10-08
- **Spec:** `docs/specs/2026-10-08-hatid-v1-design.md` §6
- **Buckets:** `hatid-sandbox` (private), `hatid-sandbox-public` (public), one account, endpoint `https://<accountId>.r2.cloudflarestorage.com`, region `auto`.
- **Token:** Object Read & Write on both buckets only. No Admin / bucket-settings permission (least privilege, by design).
- **Method:** throwaway script (aws4fetch 1.0.20, Node 22), not committed. Every object was under `hatid-spike/` and was deleted afterwards; both buckets were left with 0 objects and 0 in-progress multipart uploads under that prefix.

## History

1. **First run:** V1–V4, V6 and V7 passed. V5 returned `403 AccessDenied`. A follow-up check showed the token had no access to the public bucket at all (PUT, HEAD, LIST and same-bucket copy were all 403), so this was a token-scope problem, not an R2 limitation. Execution stopped per the V5 stop rule.
2. **After the token was fixed:** the public bucket accepts PUT/HEAD/LIST, same-bucket copy, and cross-bucket copy in both directions (all 200). The full run below passes.

## Raw results (final run)

```json
{
  "V1": {
    "control": 200,
    "altered": 403,
    "pass": true
  },
  "V2": {
    "status": 403,
    "rejected": true
  },
  "V3": {
    "control": 200,
    "oversize": 403,
    "enforced": true
  },
  "V4": {
    "status": 403,
    "pass": true
  },
  "V5": {
    "crossStatus": 200,
    "crossError": null,
    "publicMeta": [],
    "publicType": "text/plain",
    "sameStatus": 200,
    "privateMeta": [
      [
        "x-amz-meta-hatid-owner",
        "YWxpY2U"
      ],
      [
        "x-amz-meta-hatid-size",
        "10"
      ]
    ],
    "pass": true
  },
  "V6": {
    "parts": [
      [
        1,
        "&quot;79b281060d337b9b2b84ccf390adcf74&quot;",
        200
      ],
      [
        2,
        "&quot;7202826a7791073fe2787f0c94603278&quot;",
        200
      ]
    ],
    "complete": 200,
    "size": "6291456",
    "pass": true
  },
  "V7": {
    "deleteObjects": 200,
    "deleteBody": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></DeleteResult>",
    "listMultipart": 200
  }
}
```

V8 was not run (see below).

## Decisions

| # | Observed | Decision |
|---|---|---|
| V1 | Unaltered PUT 200; PUT with altered signed `x-amz-meta-hatid-owner` 403 | Design kept. |
| V2 | PUT with an extra **unsigned** `x-amz-meta-extra` header 403 | R2 rejects unsigned extra metadata. The exact-key-set check at confirm stays as defense in depth. |
| V3 | Signed `Content-Length: 10`: 10-byte body 200, 11-byte body 403 | R2 enforces it. **`DEFAULT_SIGN_CONTENT_LENGTH = true`**. Size is still re-checked at confirm. |
| V4 | URL with `X-Amz-Expires=1`, used after 2.5 s: 403 | Design kept. |
| V5 | Cross-bucket CopyObject private → public with `x-amz-metadata-directive: REPLACE`: 200, no `<Error>` body. The public copy has **no** `x-amz-meta-*` and `Content-Type: text/plain`. Same-bucket copy with `COPY`: 200, metadata kept (`hatid-owner`, `hatid-size`). | **Cross-bucket copy kept**; no fallback needed. |
| V6 | UploadPartCopy of a 6 MiB source as 5 MiB + 1 MiB parts: both parts 200, complete 200, size 6291456 | UploadPartCopy is supported. The maximum single CopyObject size was **not measured** (it would need a > 5 GiB object); the S3 limit of 5 GiB is assumed. `promote` uses CopyObject up to 5 GiB and UploadPartCopy above that (Task 8). |
| V7 | `DeleteObjects` (no Content-MD5) 200; `ListMultipartUploads` 200 | Batch delete is possible. v1 still uses single deletes (Task 7). `ListMultipartUploads` is used by cleanup. |
| V8 | **Not tested (least privilege).** The token deliberately has no bucket-settings permission, so it cannot write a CORS policy to probe the wildcard. | README uses the **explicit** `x-amz-meta-hatid-*` header list. CORS is set once in the Cloudflare dashboard; the app token only needs Object Read & Write. |

## Observations

- ETags in CopyPart/Copy XML replies are entity-encoded (`&quot;…&quot;`). The XML reader must decode `&quot;` (and the other four XML entities) before ETags are used in `CompleteMultipartUpload`. The spike sent them still encoded and R2 accepted them, but decoding is the correct behaviour.
