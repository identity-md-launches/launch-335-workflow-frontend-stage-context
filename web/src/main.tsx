import React from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadDeployment } from "./config";
import { App } from "./App";
import "./style.css";
const root = createRoot(document.getElementById("root")!);
root.render(
  <main className="boot">
    <p className="eyebrow">Momentum / Sepolia</p>
    <h1>Loading the pool.</h1>
    <p role="status">
      Checking deployment configuration and contract interfaces…
    </p>
  </main>,
);
loadDeployment()
  .then((rt) =>
    root.render(
      <React.StrictMode>
        <WagmiProvider config={rt.walletConfig}>
          <QueryClientProvider client={new QueryClient()}>
            <App rt={rt} />
          </QueryClientProvider>
        </WagmiProvider>
      </React.StrictMode>,
    ),
  )
  .catch((e) =>
    root.render(
      <main className="boot">
        <h1>Pool unavailable</h1>
        <p role="alert">{e.message}</p>
        <button onClick={() => location.reload()}>Reload configuration</button>
      </main>,
    ),
  );
