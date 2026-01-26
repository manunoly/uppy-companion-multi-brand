/**
 * Folder types for user media organization
 */

export interface Folder {
    id: number;
    name: string;
    color: string;
    isDefault: boolean;
    imageCount: number;
    createdAt: string;
}

export interface FoldersResponse {
    success: boolean;
    data: Folder[];
}
