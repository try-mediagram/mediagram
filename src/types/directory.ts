export type DirectoryTopic = {
    id: number;
    slug: string;
    label: string;
};

export type DirectoryListing = {
    id: number;
    username: string | null;
    chatId: number | null;
    handle: string;
    title: string;
    description: string | null;
    topics: DirectoryTopic[];
    totalCents: number;
    url: string | null;
    takeFirstCents: number | null;
    status?: string;
    rejectionReason?: string | null;
};
