export function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function humanizeRuleError(error?: string) {
  if (!error) return "The rule builder is unavailable. Try again.";
  if (error.includes("ai settings required")) return "AI settings are required before Cloudy can build a definition.";
  if (error.includes("ai model incompatible")) return "The selected model could not return a valid rule. Check the model in Settings or try another compatible model.";
  if (error.includes("session conflict")) return "This setup changed in another tab. Close and reopen it to continue with the latest version.";
  if (error.includes("session expired")) return "This unfinished setup expired after seven days. Start a new definition.";
  if (error.includes("pod unavailable")) return "Pair an active Pod before creating a Ping definition.";
  if (error.includes("github permission")) return "The connected GitHub account does not have merge permission for that repository. Reconnect an account with write access or choose another repository.";
  if (error.includes("github authentication")) return "Reconnect GitHub, then try again.";
  if (error.includes("github not found")) return "That repository was not found or is not visible to the connected GitHub account.";
  if (error.includes("github rate limit")) return "GitHub's API limit was reached. Wait a moment, then try again.";
  return error.charAt(0).toUpperCase() + error.slice(1) + ".";
}
