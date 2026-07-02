import { useState } from "react";
import {
  Button,
  Cell,
  Info,
  Input,
  List,
  Modal,
  Placeholder,
  Section,
  Snackbar,
  Spinner
} from "@telegram-apps/telegram-ui";
import { api } from "../api.js";
import { shortAddress } from "../format.js";

const FIELDS = [
  { key: "warningHealthFactor", label: "Warning HF" },
  { key: "dangerHealthFactor", label: "Danger HF" },
  { key: "warningBorrowRate", label: "Warning borrow rate %" },
  { key: "dangerBorrowRate", label: "Danger borrow rate %" },
  { key: "warningSupplyRate", label: "Warning supply APY %" }
];

const SUPPLY_FOOTER = "Warning supply APY %: alert when a deposit APY drops below this value.";

export default function Settings({ state, loading, error, onRefresh }) {
  const [selectedAddress, setSelectedAddress] = useState(null);
  // editor: { scope: 'default' | 'wallet', fieldKey, label } | null
  const [editor, setEditor] = useState(null);
  const [inputValue, setInputValue] = useState("");
  const [editorError, setEditorError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [snackbar, setSnackbar] = useState(null);

  const defaults = state?.defaults || {};
  const wallets = state?.wallets || [];
  const selectedWallet = wallets.find((w) => w.address === selectedAddress) || null;

  function openEditor(scope, field) {
    const current =
      scope === "default" ? defaults[field.key] : selectedWallet?.thresholds?.[field.key];
    setEditor({ scope, fieldKey: field.key, label: field.label });
    setInputValue(current != null ? String(current) : "");
    setEditorError(null);
  }

  function closeEditor() {
    if (!saving) {
      setEditor(null);
      setEditorError(null);
    }
  }

  async function saveEditor() {
    if (!editor) return;
    const num = Number(String(inputValue).trim().replace(",", "."));
    if (!Number.isFinite(num) || num <= 0) {
      setEditorError("Enter a positive number");
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      if (editor.scope === "default") {
        await api.updateDefault(editor.fieldKey, num);
      } else {
        await api.updateWalletThreshold(selectedAddress, editor.fieldKey, num);
      }
      await onRefresh();
      setEditor(null);
      setSnackbar("Saved");
    } catch (err) {
      setEditorError(err?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function clearOverride() {
    if (!editor || editor.scope !== "wallet") return;
    setSaving(true);
    setEditorError(null);
    try {
      await api.updateWalletThreshold(selectedAddress, editor.fieldKey, null);
      await onRefresh();
      setEditor(null);
      setSnackbar("Override cleared");
    } catch (err) {
      setEditorError(err?.message || "Failed to clear");
    } finally {
      setSaving(false);
    }
  }

  async function resetAllOverrides() {
    if (!selectedAddress) return;
    setResetting(true);
    try {
      await api.resetWalletThresholds(selectedAddress);
      await onRefresh();
      setSnackbar("All overrides reset");
    } catch (err) {
      setSnackbar(`Failed to reset: ${err?.message || "unknown error"}`);
    } finally {
      setResetting(false);
    }
  }

  if (!state) {
    if (loading) {
      return (
        <Placeholder description="Loading settings…">
          <Spinner size="l" />
        </Placeholder>
      );
    }
    return (
      <Placeholder
        header="Failed to load"
        description={error || "Unknown error"}
        action={
          <Button size="m" onClick={onRefresh}>
            Try again
          </Button>
        }
      />
    );
  }

  const hasCurrentOverride =
    editor?.scope === "wallet" && selectedWallet?.thresholds?.[editor.fieldKey] != null;

  return (
    <>
      {!selectedWallet ? (
        <List>
          <Section header="Global defaults" footer={SUPPLY_FOOTER}>
            {FIELDS.map((field) => (
              <Cell
                key={field.key}
                onClick={() => openEditor("default", field)}
                after={
                  <Info type="text">
                    {defaults[field.key] != null ? String(defaults[field.key]) : "—"}
                  </Info>
                }
              >
                {field.label}
              </Cell>
            ))}
          </Section>
          <Section
            header="Per-wallet overrides"
            footer="Tap a wallet to set thresholds that override the global defaults."
          >
            {wallets.length === 0 && (
              <Cell subtitle="Add wallets on the Wallets tab">No wallets</Cell>
            )}
            {wallets.map((wallet) => {
              const overrideCount = Object.values(wallet.thresholds || {}).filter(
                (v) => v != null
              ).length;
              return (
                <Cell
                  key={wallet.address}
                  subtitle={wallet.protocol || undefined}
                  after={
                    <Info type="text">
                      {overrideCount
                        ? `${overrideCount} override${overrideCount > 1 ? "s" : ""}`
                        : "inherits"}
                    </Info>
                  }
                  onClick={() => setSelectedAddress(wallet.address)}
                >
                  {shortAddress(wallet.address)}
                </Cell>
              );
            })}
          </Section>
        </List>
      ) : (
        <List>
          <Section>
            <Cell onClick={() => setSelectedAddress(null)}>‹ All settings</Cell>
          </Section>
          <Section
            header={[shortAddress(selectedWallet.address), selectedWallet.protocol]
              .filter(Boolean)
              .join(" · ")}
            footer={SUPPLY_FOOTER}
          >
            {FIELDS.map((field) => {
              const override = selectedWallet.thresholds?.[field.key];
              const hasOverride = override != null;
              return (
                <Cell
                  key={field.key}
                  onClick={() => openEditor("wallet", field)}
                  after={
                    <Info type="text" subtitle={hasOverride ? "override" : undefined}>
                      {hasOverride
                        ? String(override)
                        : `inherits (${defaults[field.key] ?? "—"})`}
                    </Info>
                  }
                >
                  {field.label}
                </Cell>
              );
            })}
          </Section>
          <div style={{ padding: "0 20px" }}>
            <Button size="m" mode="gray" stretched loading={resetting} onClick={resetAllOverrides}>
              Reset all to defaults
            </Button>
          </div>
        </List>
      )}

      <Modal
        header={<Modal.Header>{editor?.label || ""}</Modal.Header>}
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        {editor && (
          <div style={{ padding: "8px 16px 32px" }}>
            <Input
              type="text"
              inputMode="decimal"
              placeholder={
                editor.scope === "wallet"
                  ? `Inherits ${defaults[editor.fieldKey] ?? "—"}`
                  : "Value"
              }
              value={inputValue}
              status={editorError ? "error" : undefined}
              onChange={(e) => setInputValue(e.target.value)}
            />
            {editorError && (
              <div
                style={{
                  color: "var(--tgui--destructive_text_color)",
                  padding: "8px 8px 0",
                  fontSize: 14
                }}
              >
                {editorError}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 16 }}>
              <Button size="l" stretched loading={saving} onClick={saveEditor}>
                Save
              </Button>
              {hasCurrentOverride && (
                <Button size="l" stretched mode="bezeled" disabled={saving} onClick={clearOverride}>
                  Clear override (inherit)
                </Button>
              )}
              <Button size="l" stretched mode="gray" disabled={saving} onClick={closeEditor}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {snackbar && (
        <Snackbar duration={4000} onClose={() => setSnackbar(null)}>
          {snackbar}
        </Snackbar>
      )}
    </>
  );
}
