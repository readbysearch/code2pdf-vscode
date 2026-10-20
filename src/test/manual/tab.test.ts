import { strict as assert } from "node:assert";
import * as vscode from "vscode";

// Run by hand, to look at the PDF tab (it stays open for 20 seconds):
//   npm run compile && CODE2PDF_TEST_FILES='out/test/manual/tab.test.js' npx vscode-test
describe("PDF tab (manual check, not in CI)", () => {
  it("shows the workspace's PDF in a VS Code tab", async () => {
    const config = vscode.workspace.getConfiguration("code2pdf");
    await config.update("openWith", "editor", vscode.ConfigurationTarget.Workspace);
    try {
      const pdf = await vscode.commands.executeCommand<string>("code2pdf.printWorkspace");
      assert.ok(pdf);
      console.log(`Printed ${pdf}: look at its tab`);
      await new Promise((r) => setTimeout(r, 20_000));
    } finally {
      await config.update("openWith", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
