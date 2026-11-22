import { useEffect, type RefObject } from "react";
import { bindOutsidePointerDismiss } from "../src/client/engine/dom/popover-dismiss.ts";
import { useInteractionLayer, useInteractionLayers, type CloseReason } from "./interaction-layers";

export * from "../src/client/engine/dom/popover-dismiss.ts";

export function usePopoverDismiss(
	rootRef: RefObject<HTMLElement | null>,
	open: boolean,
	close: (reason: CloseReason) => void,
	options?: { layerRootRef?: RefObject<HTMLElement | null>; ownerId?: string },
) {
	const controller = useInteractionLayers();
	const panel = options?.layerRootRef ?? rootRef;
	const layer = useInteractionLayer({
		kind: "popup",
		enabled: open,
		rootRef: panel,
		anchorRef: rootRef,
		ownerId: options?.ownerId,
		onClose: (reason) => {
			close(reason);
			return "closed";
		},
	});
	useEffect(() => {
		if (!open) return;
		return bindOutsidePointerDismiss({
			getRoot: () => rootRef.current,
			getPanel: () => panel.current,
			controller,
			onOutside: () => close("outside"),
		});
	}, [open, close, rootRef, panel, controller]);
	return layer;
}
