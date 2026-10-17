export function unknownSlashCommandMessage(content: string): string | null {
  const command = content.trim().match(/^\/\S+/)?.[0];
  return command ? `Unknown command: ${command}. This command doesn't exist.` : null;
}
