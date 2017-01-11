import { ICursor } from './cursor';

/**
 * Cursor that is searchable by general search term. (No specific field, property or column filter)
 */
export interface ISearchableCursor<T> extends ICursor<T> {
    /**
     * Search terms.
     */
    readonly terms: string;

    /**
     * Used to execute a page request with an active search filter.
     */
    search(terms: string, initialPage?: number): Promise<T[]>;
}