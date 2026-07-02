import { useCallback, useEffect, useState } from "react";
import { Tabbar } from "@telegram-apps/telegram-ui";
import { api } from "./api.js";
import Positions from "./tabs/Positions.jsx";
import Wallets from "./tabs/Wallets.jsx";
import Settings from "./tabs/Settings.jsx";

function IconChart() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 23V15" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M11 23V5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M17 23V11" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M23 23V8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function IconWallet() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3.5" y="6.5" width="21" height="15" rx="3.5" stroke="currentColor" strokeWidth="2" />
      <path d="M17 12h7.5v4H17a2 2 0 1 1 0-4z" fill="currentColor" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 9h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 19h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="9" r="2.75" fill="currentColor" />
      <circle cx="18" cy="19" r="2.75" fill="currentColor" />
    </svg>
  );
}

const TABS = [
  { id: "positions", text: "Positions", Icon: IconChart },
  { id: "wallets", text: "Wallets", Icon: IconWallet },
  { id: "settings", text: "Settings", Icon: IconSettings }
];

export default function App() {
  const [tab, setTab] = useState("positions");
  const [state, setState] = useState(null);
  const [stateLoading, setStateLoading] = useState(true);
  const [stateError, setStateError] = useState(null);

  const refreshState = useCallback(async () => {
    try {
      const next = await api.getState();
      setState(next);
      setStateError(null);
      return next;
    } catch (err) {
      setStateError(err?.message || "Failed to load");
      return null;
    } finally {
      setStateLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  return (
    <>
      <div className="app-content">
        {tab === "positions" && <Positions />}
        {tab === "wallets" && (
          <Wallets state={state} loading={stateLoading} error={stateError} onRefresh={refreshState} />
        )}
        {tab === "settings" && (
          <Settings state={state} loading={stateLoading} error={stateError} onRefresh={refreshState} />
        )}
      </div>
      <Tabbar>
        {TABS.map(({ id, text, Icon }) => (
          <Tabbar.Item key={id} text={text} selected={tab === id} onClick={() => setTab(id)}>
            <Icon />
          </Tabbar.Item>
        ))}
      </Tabbar>
    </>
  );
}
