export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export function slackAccess(team: string, user: string): boolean {
  return (
    team === required("SLACK_TEAM_ID") &&
    required("SLACK_ALLOWED_USER_IDS")
      .split(",")
      .map((x) => x.trim())
      .includes(user)
  );
}
