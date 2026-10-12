import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";

// Run by hand (it opens a PDF on your screen):
//   CODE2PDF_TEST_FILES='out/test/manual/*.test.js' npx vscode-test
describe("viewer (manual check, not in CI)", () => {
  it("opens the PDF in the system viewer", async () => {
    const config = vscode.workspace.getConfiguration("code2pdf");
    await config.update("openWith", "viewer", vscode.ConfigurationTarget.Workspace);
    try {
      const folder = (vscode.workspace.workspaceFolders ?? [])[0].uri.fsPath;
      const pdf = await vscode.commands.executeCommand<string>("code2pdf.printFile", vscode.Uri.file(path.join(folder, "src/util.py")));
      assert.ok(pdf);
      console.log(`Printed ${pdf}: check that it opened in the PDF viewer`);
    } finally {
      await config.update("openWith", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
