import { ticketBranchName } from "@volli/shared";

function App() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 text-3xl">
      Volli Code
      <span className="font-mono text-sm text-primary">
        {ticketBranchName("VC-0", "monorepo migration")}
      </span>
    </div>
  );
}

export default App;
