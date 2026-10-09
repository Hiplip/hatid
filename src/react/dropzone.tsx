import {
  useCallback, useMemo, useRef, useState,
  type ChangeEvent, type DragEvent, type HTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref,
} from "react";
import { clientContentType, isAllowedType } from "../core/mime";
import { parseSize } from "../core/units";

export type DropzoneRejection = { file: File; reason: "type" | "size" | "count" };

export type DropzoneRenderProps = {
  getRootProps: (props?: HTMLAttributes<HTMLElement>) => HTMLAttributes<HTMLElement>;
  getInputProps: (props?: InputHTMLAttributes<HTMLInputElement>) => InputHTMLAttributes<HTMLInputElement> & { ref: Ref<HTMLInputElement> };
  isDragActive: boolean;
  open: () => void;
  rejections: DropzoneRejection[];
};

export type DropzoneProps = {
  upload: (files: File[]) => unknown;
  /** MIME types or "type/*" wildcards. Client-side hint only; the server enforces the real rules. */
  accept?: readonly string[];
  maxSize?: number | string;
  maxFiles?: number;
  multiple?: boolean;
  disabled?: boolean;
  onReject?: (rejections: DropzoneRejection[]) => void;
  children: (props: DropzoneRenderProps) => ReactNode;
};

/** Headless, unstyled drop target. Wrap it with your own (e.g. shadcn/ui) markup. */
export function Dropzone(props: DropzoneProps) {
  const { upload, accept, maxSize, maxFiles, multiple = true, disabled = false, onReject, children } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [isDragActive, setDragActive] = useState(false);
  const [rejections, setRejections] = useState<DropzoneRejection[]>([]);
  const acceptList = useMemo(() => accept?.map((a) => a.trim().toLowerCase()), [accept]);
  const maxBytes = useMemo(() => (maxSize === undefined ? undefined : parseSize(maxSize, "maxSize")), [maxSize]);

  const handle = useCallback((list: FileList | File[] | null | undefined) => {
    if (!list || disabled) return;
    const accepted: File[] = [];
    const rejected: DropzoneRejection[] = [];
    const limit = multiple ? maxFiles : 1;
    for (const file of Array.from(list)) {
      if (acceptList && !isAllowedType(clientContentType(file.type), acceptList)) rejected.push({ file, reason: "type" });
      else if (maxBytes !== undefined && file.size > maxBytes) rejected.push({ file, reason: "size" });
      else if (limit !== undefined && accepted.length >= limit) rejected.push({ file, reason: "count" });
      else accepted.push(file);
    }
    setRejections(rejected);
    if (rejected.length > 0) onReject?.(rejected);
    if (accepted.length > 0) void upload(accepted);
  }, [acceptList, disabled, maxBytes, maxFiles, multiple, onReject, upload]);

  const open = useCallback(() => { if (!disabled) inputRef.current?.click(); }, [disabled]);

  const getRootProps: DropzoneRenderProps["getRootProps"] = (p = {}) => ({
    ...p,
    role: "button",
    tabIndex: disabled ? -1 : 0,
    "aria-disabled": disabled,
    onClick: (e: MouseEvent<HTMLElement>) => { p.onClick?.(e); if (!e.defaultPrevented) open(); },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      p.onKeyDown?.(e);
      if (!e.defaultPrevented && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); }
    },
    onDragEnter: (e: DragEvent<HTMLElement>) => { p.onDragEnter?.(e); e.preventDefault(); depth.current++; if (!disabled) setDragActive(true); },
    onDragOver: (e: DragEvent<HTMLElement>) => { p.onDragOver?.(e); e.preventDefault(); },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      p.onDragLeave?.(e);
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragActive(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      p.onDrop?.(e);
      e.preventDefault();
      depth.current = 0;
      setDragActive(false);
      handle(e.dataTransfer?.files);
    },
  });

  const getInputProps: DropzoneRenderProps["getInputProps"] = (p = {}) => ({
    ...p,
    ref: inputRef,
    type: "file",
    tabIndex: -1,
    style: { display: "none", ...p.style },
    multiple,
    disabled,
    ...(acceptList ? { accept: acceptList.join(",") } : {}),
    onClick: (e: MouseEvent<HTMLInputElement>) => { p.onClick?.(e); e.stopPropagation(); },
    onChange: (e: ChangeEvent<HTMLInputElement>) => { p.onChange?.(e); handle(e.target.files); e.target.value = ""; },
  });

  return <>{children({ getRootProps, getInputProps, isDragActive, open, rejections })}</>;
}
