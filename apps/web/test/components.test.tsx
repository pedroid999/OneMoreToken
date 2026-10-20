// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../src/components/Button";
import { EmptyState } from "../src/components/EmptyState";
import { Kbd } from "../src/components/Kbd";
import { Panel } from "../src/components/Panel";
import { SegmentedControl } from "../src/components/SegmentedControl";
import { renderWithI18n } from "./helpers";

afterEach(cleanup);

describe("Button (spec §8.2 states)", () => {
  it("calls onClick at rest", async () => {
    const onClick = vi.fn();
    await renderWithI18n(<Button onClick={onClick}>{"Go"}</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled and ignores clicks", async () => {
    const onClick = vi.fn();
    await renderWithI18n(
      <Button disabled onClick={onClick}>
        {"Go"}
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("announces loading with aria-busy, stays focusable and ignores clicks", async () => {
    const onClick = vi.fn();
    await renderWithI18n(
      <Button loading onClick={onClick}>
        {"Save"}
      </Button>,
    );
    const button = screen.getByRole("button", { name: /Save/ });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("exposes the pressed state and the variant", async () => {
    await renderWithI18n(
      <Button pressed variant="primary">
        {"Pin"}
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Pin" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.dataset.variant).toBe("primary");
  });
});

function Segmented({ onChange = () => {} }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("b");
  return (
    <SegmentedControl
      label="Pick"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      options={[
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ]}
    />
  );
}

describe("SegmentedControl (spec §8.4 keyboard)", () => {
  it("is a radiogroup with a roving tabindex on the checked option", async () => {
    await renderWithI18n(<Segmented />);
    expect(screen.getByRole("radiogroup", { name: "Pick" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("moves selection and focus with arrow keys, wrapping, and Home/End", async () => {
    const onChange = vi.fn();
    await renderWithI18n(<Segmented onChange={onChange} />);
    const radio = (name: string) => screen.getByRole("radio", { name });

    fireEvent.keyDown(radio("B"), { key: "ArrowRight" });
    expect(radio("C").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("C"));

    fireEvent.keyDown(radio("C"), { key: "ArrowDown" });
    expect(radio("A").getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radio("A"), { key: "ArrowLeft" });
    expect(radio("C").getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radio("C"), { key: "Home" });
    expect(radio("A").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("A"), { key: "End" });
    expect(document.activeElement).toBe(radio("C"));

    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["c", "a", "c", "a", "c"]);
  });

  it("selects on click", async () => {
    await renderWithI18n(<Segmented />);
    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    expect(screen.getByRole("radio", { name: "A" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Panel (spec §8.2 states)", () => {
  it("renders its content when ready", async () => {
    await renderWithI18n(<Panel title="Usage">{"content"}</Panel>);
    expect(screen.getByRole("region", { name: "Usage" }).textContent).toContain("content");
  });

  it("shows a loading status and marks itself busy", async () => {
    await renderWithI18n(
      <Panel title="Usage" status="loading">
        {"content"}
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Usage" });
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(region.textContent).not.toContain("content");
  });

  it("shows the empty state with the action to take", async () => {
    await renderWithI18n(
      <Panel
        title="Usage"
        status="empty"
        empty={<EmptyState title="No data" body="Ingest first" command="pnpm omt ingest" />}
      >
        {"content"}
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Usage" });
    expect(region.textContent).toContain("No data");
    expect(region.querySelector("code")?.textContent).toBe("pnpm omt ingest");
  });

  it("shows an error alert with a retry action", async () => {
    const onRetry = vi.fn();
    await renderWithI18n(
      <Panel title="Usage" status="error" error={{ message: "API down", onRetry }}>
        {"content"}
      </Panel>,
    );
    expect(screen.getByRole("alert").textContent).toContain("API down");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("Kbd", () => {
  it("renders a keyboard key", async () => {
    const { container } = await renderWithI18n(<Kbd>{"?"}</Kbd>);
    expect(container.querySelector("kbd")?.textContent).toBe("?");
  });
});
