"use client";
import { Dropzone, httpTransport, useUpload } from "@hiplip/hatid/react";
import { useCallback, useEffect, useState } from "react";
import type { AppUploads } from "@/lib/hatid";
import type { FileRecord } from "@/lib/store";

const transport = httpTransport<AppUploads>("/api/upload");

export function Uploader() {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const refresh = useCallback(async () => {
    const res = await fetch("/api/files");
    setFiles(res.ok ? ((await res.json()) as FileRecord[]) : []);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const { upload, items, progress, status, retry, cancel, reset } = useUpload({
    transport, route: "document", maxFiles: 5, onAllComplete: () => void refresh(),
  });

  const remove = async (key: string) => {
    await fetch("/api/files/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    await refresh();
  };

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px" }}>
      <h1>hatid example</h1>
      <p><strong>Demo session only:</strong> your identity is a random cookie.</p>

      <Dropzone upload={upload} accept={["image/*", "application/pdf", "text/plain"]} maxFiles={5}>
        {({ getRootProps, getInputProps, isDragActive }) => (
          <div {...getRootProps({ style: { border: "2px dashed #888", borderRadius: 8, padding: 32, textAlign: "center", cursor: "pointer", background: isDragActive ? "#eef3ff" : undefined } })}>
            <input {...getInputProps()} />
            Drop files here or click to choose (images, PDF, text; max 5 MB each)
          </div>
        )}
      </Dropzone>

      <p>
        <button type="button" onClick={() => void upload(new File([new Uint8Array(6 * 1024 * 1024)], "too-big.pdf", { type: "application/pdf" }))}>
          Try a 6 MB file (rejected by the server)
        </button>{" "}
        <button type="button" onClick={reset}>Clear finished</button>
      </p>

      <p>Overall: {Math.round(progress * 100)}% ({status})</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.fileName ?? "(blob)"}: {item.status} {Math.round(item.progress * 100)}%
            {item.status === "uploading" && <button type="button" onClick={() => cancel(item.id)}>Cancel</button>}
            {item.error && <> ({item.error.code}: {item.error.message}){item.error.retryable && <button type="button" onClick={() => void retry(item.id)}>Retry</button>}</>}
          </li>
        ))}
      </ul>

      <h2>Your files</h2>
      <ul>
        {files.map((f) => (
          <li key={f.key}>
            {f.fileName ?? f.key} ({f.size.toLocaleString()} bytes){" "}
            <a href={`/api/files/download?key=${encodeURIComponent(f.key)}`}>Download</a>{" "}
            <button type="button" onClick={() => void remove(f.key)}>Delete</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
