/**
 * The dock shell's variant key (the WAAPI height-morph trigger).
 */
export function dockStateKey(mode: string, docked: boolean, expanded: boolean): string {
	return docked ? `${mode}:${expanded}` : `${mode}:-`;
}
