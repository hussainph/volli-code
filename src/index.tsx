import React from "react";
import ReactDOM from "react-dom/client";

function App() {
  return (
    <div style={{ padding: "20px", fontFamily: "system-ui" }}>
      <h1>Volli Electron Spike</h1>
      <p>Kanban board + terminal UI test</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
