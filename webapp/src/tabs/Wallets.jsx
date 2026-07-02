import { useState } from "react";
import {
  Badge,
  Button,
  Cell,
  IconButton,
  List,
  Modal,
  Placeholder,
  Section,
  Snackbar,
  Spinner,
  Textarea
} from "@telegram-apps/telegram-ui";
import { api } from "../api.js";
import { shortAddress } from "../format.js";

function IconTrash() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10 11.5v6M14 11.5v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function Wallets({ state, loading, error, onRefresh }) {
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [snackbar, setSnackbar] = useState(null);

  const wallets = state?.wallets || [];

  async function handleAdd() {
    const value = input.trim();
    if (!value) return;
    setAdding(true);
    setAddError(null);
    setLastResult(null);
    try {
      const result = await api.addWallets(value);
      const added = result?.added?.length || 0;
      const skipped = result?.skipped?.length || 0;
      setLastResult(result);
      setSnackbar(`Added ${added} · Skipped ${skipped}`);
      if (added > 0) setInput("");
      await onRefresh();
    } catch (err) {
      setAddError(err?.message || "Failed to add wallets");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.deleteWallet(toDelete.address);
      setSnackbar(`Removed ${shortAddress(toDelete.address)}`);
      await onRefresh();
    } catch (err) {
      setSnackbar(`Failed to remove: ${err?.message || "unknown error"}`);
    } finally {
      setDeleting(false);
      setToDelete(null);
    }
  }

  if (!state) {
    if (loading) {
      return (
        <Placeholder description="Loading wallets…">
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

  return (
    <>
      <List>
        <Section header="Wallets">
          {wallets.length === 0 && (
            <Cell subtitle="Add one below to start monitoring">No wallets yet</Cell>
          )}
          {wallets.map((wallet) => (
            <Cell
              key={wallet.address}
              subtitle={wallet.protocol || undefined}
              description={wallet.address}
              after={
                <IconButton
                  mode="plain"
                  size="s"
                  aria-label="Remove wallet"
                  style={{ color: "var(--tgui--destructive_text_color)" }}
                  onClick={() => setToDelete(wallet)}
                >
                  <IconTrash />
                </IconButton>
              }
            >
              {shortAddress(wallet.address)}
            </Cell>
          ))}
        </Section>

        <Section
          header="Add wallets"
          footer="One or many addresses, separated by spaces or new lines. Adding scans chains and can take up to a minute."
        >
          <Textarea
            placeholder={"0x7A58…\nEiN7…"}
            rows={3}
            value={input}
            disabled={adding}
            onChange={(e) => setInput(e.target.value)}
          />
          <div style={{ padding: 16 }}>
            <Button
              size="m"
              stretched
              loading={adding}
              disabled={adding || !input.trim()}
              onClick={handleAdd}
            >
              {adding ? "Scanning chains…" : "Add wallets"}
            </Button>
          </div>
          {addError && (
            <Cell style={{ color: "var(--tgui--destructive_text_color)" }} subtitle={addError}>
              Failed to add
            </Cell>
          )}
        </Section>

        {lastResult && ((lastResult.added?.length || 0) > 0 || (lastResult.skipped?.length || 0) > 0) && (
          <Section header="Last result">
            {(lastResult.added || []).map((item, i) => (
              <Cell
                key={`added-${i}`}
                subtitle={item.protocol || undefined}
                after={
                  <Badge type="number" mode="primary" style={{ background: "var(--tgui--green)" }}>
                    Added
                  </Badge>
                }
              >
                {shortAddress(item.address)}
              </Cell>
            ))}
            {(lastResult.skipped || []).map((item, i) => (
              <Cell
                key={`skipped-${i}`}
                subtitle={item.reason || undefined}
                after={
                  <Badge type="number" mode="critical">
                    Skipped
                  </Badge>
                }
              >
                {shortAddress(item.address)}
              </Cell>
            ))}
          </Section>
        )}
      </List>

      <Modal
        header={<Modal.Header>Remove wallet</Modal.Header>}
        open={!!toDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setToDelete(null);
        }}
      >
        <Placeholder
          header={toDelete ? shortAddress(toDelete.address) : ""}
          description="Stop monitoring this wallet? Its per-wallet settings will be removed too."
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "0 20px 32px"
          }}
        >
          <Button
            size="l"
            stretched
            loading={deleting}
            style={{ background: "var(--tgui--destructive_text_color)" }}
            onClick={handleDelete}
          >
            Remove
          </Button>
          <Button size="l" stretched mode="gray" disabled={deleting} onClick={() => setToDelete(null)}>
            Cancel
          </Button>
        </div>
      </Modal>

      {snackbar && (
        <Snackbar duration={4000} onClose={() => setSnackbar(null)}>
          {snackbar}
        </Snackbar>
      )}
    </>
  );
}
