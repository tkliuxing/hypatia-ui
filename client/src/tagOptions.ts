// tags is null when the CLI could not list them.
export interface TagRoster {
  shelf: string;
  tags: string[] | null;
}

// A memory shelf carries well over a thousand tags, so the datalist only offers
// the ones matching what is being typed.
export const MAX_TAG_OPTIONS = 50;

// The roster from `hypatia tag list` when it was read for this shelf, filtered
// by the current input with the same case-insensitive substring rule the tag
// filter itself uses.
export function tagOptions(roster: TagRoster | null, shelf: string, input: string, maximum = MAX_TAG_OPTIONS): string[] {
  const tags = roster?.shelf === shelf ? roster.tags : null;
  if (!tags) return [];

  const needle = input.trim().toLocaleLowerCase();
  return tags
    .filter((tag) => tag && (!needle || tag.toLocaleLowerCase().includes(needle)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maximum);
}
