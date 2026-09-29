"use client";
import React from "react";
import { ProjectPreview } from "@webprodigies/flute/preview";
import { sceneModules } from "./catalog";
// Host-owned development flag: no process, Vite or Electron globals in this adapter.
export function FluteProjectPreview({ children, enabled, active, ...props }) {
  if (!enabled) return children;
  return <ProjectPreview {...props} projectId="7ae23748-2618-4a3a-be3f-b787a90e8383" enabled={enabled} active={active} sceneModules={sceneModules}>{children}</ProjectPreview>;
}
