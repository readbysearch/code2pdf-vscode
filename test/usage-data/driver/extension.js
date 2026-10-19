// Helper for test/usage-data.sh, installed next to the packaged code2pdf extension: prints one
// file with it, as a person would, writes down what happened, then quits VS Code. The file and
// the result's path come from the code2pdfCheck.* user settings the script writes.
const vscode = require("vscode");
const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.activate = async () => {
  const check = vscode.workspace.getConfiguration("code2pdfCheck");
  const code2pdf = vscode.extensions.getExtension("readbysearch.code2pdf");
  const result = { telemetryEnabled: vscode.env.isTelemetryEnabled, code2pdf: code2pdf && code2pdf.packageJSON.version };
  await sleep(3000);
  try {
    result.pdf = await vscode.commands.executeCommand("code2pdf.printFile", vscode.Uri.file(check.get("file")));
  } catch (error) {
    result.error = String(error);
  }
  await sleep(10000);  // time for the usage events to be posted
  fs.writeFileSync(check.get("result"), JSON.stringify(result));
  await vscode.commands.executeCommand("workbench.action.quit");
};
