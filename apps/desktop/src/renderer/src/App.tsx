import { ticketBranchName } from "@volli/shared";

import { font, palette } from "@renderer/theme/tokens";

function App() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        width: "100vw",
        height: "100vh",
        margin: 0,
        background: palette.background,
        color: palette.foreground,
        fontFamily: font.sans,
        fontSize: "2rem",
      }}
    >
      Volli Code
      <span style={{ fontSize: "0.9rem", color: palette.accent, fontFamily: font.mono }}>
        {ticketBranchName("VC-0", "monorepo migration")}
      </span>
    </div>
  );
}

export default App;
