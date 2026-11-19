export interface LearnHarnessImportReport {
	sourceDirectory: string;
	settingsImported: boolean;
	themesImported: number;
	promptsImported: number;
	sourcesImported: number;
	nodesImported: number;
	chainsImported: number;
	positionsImported: number;
	chatsImported: number;
	objectsStored: number;
	objectsDeduplicated: number;
	flashcardDecksImported: number;
	flashcardCardsImported: number;
	corruptFilesSkipped: number;
}
