/**
 * Renders question text where `backticks` mark code (paths, commands).
 * Everything is rendered as React text nodes, never as HTML.
 */
export function TaskText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}
    </>
  );
}
