// tests/react/dropzone.test.tsx
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropzone } from "../../src/react/dropzone";

afterEach(cleanup);

const f = (name: string, size: number, type: string) => new File([new Uint8Array(size)], name, { type });

function setup(props: Partial<Parameters<typeof Dropzone>[0]> = {}) {
  const upload = vi.fn();
  const onReject = vi.fn();
  render(
    <Dropzone upload={upload} onReject={onReject} accept={["image/*", "application/pdf"]} maxSize="1KB" maxFiles={2} {...props}>
      {({ getRootProps, getInputProps, isDragActive, rejections }) => (
        <div data-testid="root" {...getRootProps()}>
          <input data-testid="input" {...getInputProps()} />
          {isDragActive ? "active" : "idle"} {rejections.length}
        </div>
      )}
    </Dropzone>,
  );
  return { upload, onReject, root: screen.getByTestId("root"), input: screen.getByTestId("input") as HTMLInputElement };
}

describe("Dropzone", () => {
  it("accepts matching files and reports rejections with reasons", () => {
    const { upload, onReject, root } = setup();
    const files = [f("a.png", 10, "image/png"), f("b.txt", 10, "text/plain"), f("c.pdf", 5000, "application/pdf"), f("d.jpg", 10, "image/jpeg"), f("e.png", 10, "image/png")];
    fireEvent.drop(root, { dataTransfer: { files } });
    expect(upload).toHaveBeenCalledWith([files[0], files[3]]);
    expect(onReject).toHaveBeenCalledWith([
      { file: files[1], reason: "type" }, { file: files[2], reason: "size" }, { file: files[4], reason: "count" },
    ]);
    expect(root.textContent).toContain("3");
  });

  it("tracks drag state", () => {
    const { root } = setup();
    fireEvent.dragEnter(root, { dataTransfer: { files: [] } });
    expect(root.textContent).toContain("active");
    fireEvent.dragLeave(root, { dataTransfer: { files: [] } });
    expect(root.textContent).toContain("idle");
  });

  it("opens the picker on click and Enter, and uploads chosen files", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const { root, input, upload } = setup();
    expect(root.getAttribute("role")).toBe("button");
    expect(root.getAttribute("tabindex")).toBe("0");
    fireEvent.click(root);
    fireEvent.keyDown(root, { key: "Enter" });
    expect(click).toHaveBeenCalledTimes(2);
    expect(input.accept).toBe("image/*,application/pdf");
    expect(input.multiple).toBe(true);
    const file = f("x.png", 10, "image/png");
    fireEvent.change(input, { target: { files: [file] } });
    expect(upload).toHaveBeenCalledWith([file]);
    click.mockRestore();
  });

  it("does nothing when disabled", () => {
    const { root, upload } = setup({ disabled: true });
    fireEvent.drop(root, { dataTransfer: { files: [f("a.png", 10, "image/png")] } });
    expect(upload).not.toHaveBeenCalled();
    expect(root.getAttribute("aria-disabled")).toBe("true");
  });
});
