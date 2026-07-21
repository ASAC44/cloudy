"use client";

import { useEffect, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import "@excalidraw/excalidraw/index.css";

const scene = fetch("/cloudy-system-architecture.excalidraw?v=2").then(async (response) => {
  if (!response.ok) {
    throw new Error("Cloudy system map could not be loaded");
  }

  return (await response.json()) as ExcalidrawInitialDataState;
});

export function InteractiveArchitecture() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    if (!api) return;

    let active = true;

    void scene.then((data) => {
      if (!active) return;

      api.updateScene({ elements: data.elements ?? [] });
      requestAnimationFrame(() => {
        api.scrollToContent(api.getSceneElements(), {
          fitToViewport: true,
          viewportZoomFactor: 0.92,
        });
      });
    });

    return () => {
      active = false;
    };
  }, [api]);

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      viewModeEnabled
      zenModeEnabled
      theme="light"
      autoFocus={false}
      handleKeyboardGlobally={false}
      UIOptions={{
        canvasActions: {
          changeViewBackgroundColor: false,
          clearCanvas: false,
          export: false,
          loadScene: false,
          saveAsImage: false,
          saveToActiveFile: false,
          toggleTheme: false,
        },
        tools: { image: false },
      }}
    />
  );
}
