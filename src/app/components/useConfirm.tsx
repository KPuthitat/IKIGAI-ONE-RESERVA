"use client";

import { useState, useCallback, type ReactNode } from "react";
import ConfirmModal from "./ConfirmModal";

// Reusable confirm/prompt hook — replaces window.confirm() and window.prompt().
//
// Usage:
//   const { confirm, ConfirmDialog } = useConfirm();
//   const result = await confirm({ title: "ยืนยัน", confirmLabel: "ตกลง", cancelLabel: "ยกเลิก" });
//   if (result === null) return;            // user cancelled
//   // result === "" if no input, or the input string if withInput=true
//
// Then render `{ConfirmDialog}` somewhere in your component tree.

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  variant?: "default" | "danger" | "warning" | "info";
  withInput?: boolean;
  inputLabel?: string;
  inputPlaceholder?: string;
  inputDefaultValue?: string;
};

export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<string | null>;
  ConfirmDialog: React.ReactNode;
} {
  const [state, setState] = useState<{
    options: ConfirmOptions;
    resolver: (value: string | null) => void;
  } | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setState({ options, resolver: resolve });
    });
  }, []);

  const ConfirmDialog = state ? (
    <ConfirmModal
      open
      title={state.options.title}
      body={state.options.body}
      confirmLabel={state.options.confirmLabel}
      cancelLabel={state.options.cancelLabel}
      variant={state.options.variant}
      withInput={state.options.withInput}
      inputLabel={state.options.inputLabel}
      inputPlaceholder={state.options.inputPlaceholder}
      inputDefaultValue={state.options.inputDefaultValue}
      onConfirm={(val) => {
        state.resolver(val);
        setState(null);
      }}
      onCancel={() => {
        state.resolver(null);
        setState(null);
      }}
    />
  ) : null;

  return { confirm, ConfirmDialog };
}
