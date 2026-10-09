export type Visibility = "public" | "private";

export type UploadedFile = {
  key: string;
  visibility: Visibility;
  size: number;
  contentType: string;
  /** Present for public files only. */
  url?: string;
};

export type SingleIssue = { kind: "single"; key: string; url: string; method: "PUT"; headers: Record<string, string> };
export type MultipartIssue = { kind: "multipart"; key: string; uploadId: string; partSize: number; partCount: number; token: string };
export type IssueResult = SingleIssue | MultipartIssue;
export type SignedPart = { partNumber: number; url: string; headers: Record<string, string> };
export type CompletedPart = { partNumber: number; etag: string };
export type UploadAction = "issue" | "confirm" | "signParts" | "complete" | "abort";

/** Shape of the phantom `~types` field on `Uploads`, used for client-side inference. */
export type UploadsTypes = { routes: Record<string, { input: unknown }> };

type TypesOf<U> = U extends { readonly "~types"?: infer T } ? NonNullable<T> : never;

export type RouteName<U> = [TypesOf<U>] extends [never]
  ? string
  : TypesOf<U> extends UploadsTypes ? Extract<keyof TypesOf<U>["routes"], string> : string;

export type RouteInput<U, R extends string> = [TypesOf<U>] extends [never]
  ? unknown
  : TypesOf<U> extends UploadsTypes
    ? R extends keyof TypesOf<U>["routes"] ? TypesOf<U>["routes"][R]["input"] : never
    : unknown;
