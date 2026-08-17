"use client";

import { useState } from "react";
import { uploadDocument } from "@/app/actions/documents";
import { UploadCloud, Loader2 } from "lucide-react";

export function DocumentUpload() {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleFile(file: File) {
    if (!file) return;
    setError(null);
    setSuccess(null);
    setIsUploading(true);

    const formData = new FormData();
    formData.append("file", file);

    const res = await uploadDocument(formData);
    
    setIsUploading(false);

    if ("error" in res && typeof res.error === "string") {
      setError(res.error);
    } else if ("message" in res && typeof res.message === "string") {
      setSuccess(res.message);
    }
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function onDragLeave() {
    setIsDragging(false);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  }

  return (
    <div className="w-full">
      <label
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
          isDragging
            ? "border-primary bg-primary/5"
          : "border-border/60 bg-muted/20 hover:bg-muted/40 focus-within:border-foreground"
        } ${isUploading ? "pointer-events-none opacity-70" : ""}`}
      >
        <div className="flex flex-col items-center justify-center pt-5 pb-6">
          {isUploading ? (
            <Loader2 className="w-8 h-8 mb-4 text-muted-foreground animate-spin" />
          ) : (
            <UploadCloud className="w-8 h-8 mb-4 text-muted-foreground" />
          )}
          <p className="mb-2 text-sm text-foreground font-medium">
            {isUploading ? "Uploading & Processing..." : "Click or drag file to upload"}
          </p>
          <p className="text-xs text-muted-foreground">
            Markdown, PDF, or Plain Text · Up to 10 MB
          </p>
        </div>
        <input 
          type="file" 
          className="hidden" 
          accept=".pdf,.md,.txt,text/plain,text/markdown,application/pdf" 
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              handleFile(e.target.files[0]);
              // Reset the input so the same file can be uploaded again if it failed
              e.target.value = "";
            }
          }}
          disabled={isUploading}
        />
      </label>
      
      {error && (
        <p className="text-sm text-destructive mt-2">
          {error}
        </p>
      )}
      {success && <p className="mt-2 text-sm text-green-700 dark:text-green-400">{success}</p>}
    </div>
  );
}
