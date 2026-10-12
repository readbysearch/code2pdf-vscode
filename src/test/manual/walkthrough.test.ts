// Manual check: opening the Get Started walkthrough activates the extension (so its install step
// can check itself off), with no activationEvents in package.json. Run by itself, so nothing else
// activates the extension first:
//   CODE2PDF_TEST_FILES='out/test/manual/walkthrough.test.js' npx vscode-test
import { strict as assert } from "node:assert";
import * as vscode from "vscode";

describe("walkthrough (manual)", () => {
  it("opening it activates the extension", async () => {
    const extension = vscode.extensions.getExtension("readbysearch.code2pdf");
    assert.equal(extension?.isActive, false, "not active before");
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", "readbysearch.code2pdf#start", false);
    for (let i = 0; i < 50 && !extension?.isActive; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`VS Code ${vscode.version}: active after opening the walkthrough: ${extension?.isActive}`);
    assert.equal(extension?.isActive, true);
  });
});
