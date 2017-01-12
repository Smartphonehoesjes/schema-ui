import { ICursor, CursorLoadingState } from './cursor';

import { SchemaHyperlinkDescriptor, IdentityValues } from '../models/index';

import { ISchemaAgent, SchemaAgentResponse } from '../agents/schema-agent';
import { EndpointSchemaAgent } from '../agents/endpoint-schema-agent';

import * as _ from 'lodash';
import * as debuglib from 'debug';

var debug = debuglib('schema:endpoint:cursor');

/**
 * Cursor that can traverse standardized endpoints.
 *
 * In order to be able to traverse an endpoint of this type, the endpoint needs to support:
 *
 * @event afterPageChange After a page change has ocurred.
 */
export class EndpointCursor<T> implements ICursor<T> {
    //region get/set limit
        private _limit: number = 40;

        /**
         * The limit of the items on a page.
         *
         * Also called "Items per Page", "Page Count", ...
         */
        public get limit(): number {
            return this._limit;
        }
        public set limit(value: number) {
            if (!_.isInteger(value) || value < 1) {
                debug('[warn] Invalid value given for the limit value.');
                return;
            }
            this._limit = value;
            if (!!this.autoReload) {
                this.select(this.current);
            }
        }
    //endregion

    //region get/set current
        private _current: number = 1;

        /**
         * The page that the items collection currently reflects in the datasource.
         */
        public get current(): number {
            return this._current;
        }
        public set current(value: number) {
            if (!_.isInteger(value) || value < 1) {
                debug('[warn] Invalid value given for the current value.');
                return;
            }
            if (!!this.autoReload) {
                this.select(value);
            }
            else {
                debug('[warn] Setting the current page does not work when EndpointCursor.autoReload is set to false!');
            }
        }
    //endregion

    //region get/set count
        public _count: number = 0;

        /**
         * Total number of items in the datasource.
         */
        public get count(): number {
            return this._count;
        }
    //endregion

    //region get/set totalPages
        public _totalPages: number = 1;

        /**
         * Total number of pages in the datasource.
         */
        public get totalPages(): number {
            return this._totalPages;
        }
    //endregion

    //region get/set items
        public _items: T[] = [];

        /**
         * Items in the current page.
         */
        public get items(): T[] {
            return this._items;
        }
    //endregion

    /**
     * Parameter is used to indicate that the cursor is loading.
     * @default CursorLoadingState.Uninitialized
     */
    public readonly loadingState: CursorLoadingState = CursorLoadingState.Uninitialized;

    /**
     * Whether or not to automatically reload the page when the page limit or other property is changed.
     */
    public autoReload: boolean = false;

    /**
     * @param agent The agent to make the requests with.
     * @param linkName The link
     * @param initialPage The initial page to load. If set to NULL, will not load an initial page, and will wait for a call to filter(), next(), ...
     * @param limit The maximum amount of items per page.
     */
    public constructor(
        private readonly agent: ISchemaAgent,
        private readonly linkName: string,
        initialPage: number | null,
        limit?: number,
        private paginationInfoExtractor: PaginationInfoExtractorFunc = genericPaginationInfoExtractor,
        private paginationRequestGenerator: PaginationRequestGeneratorFunc = genericPaginationRequestGenerator
    ) { }

//region Page changing
    /**
     * Whether there's a page before the current one.
     */
    public hasPrevious(): boolean {
        return this.current > 1;
    }

    /**
     * Whether there's a page after the current one.
     */
    public hasNext(): boolean {
        return this.current < this.totalPages;
    }

    /**
     * Used to navigate to the next page.
     *
     * @return A promise resolving in the page's items.
     */
    public next(): Promise<T[]> {
        if (!this.hasNext()) {
            return Promise.reject('This the last page!');
        }
        return this.select(this.current + 1);
    }

    /**
     * Used to navigate to the previous page.
     *
     * @return A promise resolving in the page's items.
     */
    public previous(): Promise<T[]> {
        if (!this.hasPrevious()) {
            return Promise.reject('This the first page!');
        }
        return this.select(this.current - 1);
    }

    /**
     * Reloads the currently loaded page.
     *
     * @return A promise resolving in the items on the current page.
     */
    public refresh(): Promise<T[]> {
        return this.select(this.current, true);
    }

    /**
     * Select a page by number.
     *
     * @param page The 1-indexed page to navigate to.
     * @param forceReload Whether or not to force a reload of the age, even if we are already on the given page.
     *
     * @return A promise resolving in the page's items.
     */
    public select(page: number, forceReload: boolean = false): Promise<T[]> {
        // Check pagenumber validity
        if (!_.isInteger(page) || page < 1) {
            throw new Error('Pagenumber has to be an integer of 1 or higher.');
        }
        if (page === this.current && !forceReload) {
            return Promise.resolve(this.items);
        }

        // Get the correct link
        let link: SchemaHyperlinkDescriptor;
        if (_.isString(this.linkName)) {
            link = this.agent.schema.getLink(this.linkName);
        }
        else {
            link = this.agent.schema.getFirstLink([
                'list',       // The name this library propagates.
                'collection', // Defined in the Item and Collection rfc6573
                'index'
            ]);
        }
        if (!link) {
            throw new Error('Unable to find a link for this cursor to fetch any pages.');
        }

        // Create urlData object from absolutely all data we can possibly find.
        let urlData = this.paginationRequestGenerator(page, this.limit);

        // Execute the request.
        return this.agent
            .execute<void, any>(link, void 0, urlData)
            .then(response => {
                this._current = page;

                let info = this.paginationInfoExtractor<T>(response);
                this._items = info.items || [];
                this._totalPages = info.totalPages;
                this._count = info.count;

                if (this.items.length > this.limit) {
                    debug(`[warn] The amount of items returned (${this.items.length}) by the agent/server/service was higher than the amount of requested items (${this.limit})!`);
                }

                return info.items;
            });
    }
//endregion

    /**
     * Get all the items inside the collection as a promised list.
     *
     * As some collections may contain millions of items, please *always* check the total count of the collection first.
     *
     * @param limit The maximum amount of items per page to use during the fetching of all pages.
     *
     * @return A promise resolving in all the items in this collection (Beware, this can pottentially be millions of items).
     */
    public all(limit?: number): Promise<T[]> {
        return new Promise((resolve, reject) => {
            var firstPage: Promise<T[]>;
            if (this.loadingState > CursorLoadingState.Uninitialized) {
                if (this.loadingState === CursorLoadingState.Ready) {
                    firstPage = Promise.resolve(this.items);
                }
                else {
                    firstPage = new Promise(resolve => this.once('afterPageChange', x => resolve(x.Items)));
                }
            }
            else {
                firstPage = <any> this.select(1);
            }

            firstPage.then(items => {
                var promises: Promise<T[]>[] = [Promise.resolve(this.items)];
                for (var i = 2; i <= this.totalPages; i++) {
                    promises.push(this.select(i));
                }
                Promise
                    .all(promises)
                    .then(result => {
                        resolve(_.flatten(result));
                    })
                    .catch(reject);
            });
        });
    }
}

/**
 * Interface defining the properties that should be extracted from a pagination response.
 */
export interface PaginationInfo<T> {
    /**
     * The items that came in the response.
     */
    items: T[];

    /**
     * Total number of pages in the resource.
     */
    totalPages: number;

    /**
     * Total number of items in the collection.
     */
    count: number;
}

/**
 * Function that can extract the needed info for the cursor to load the given response as the current page.
 */
export type PaginationInfoExtractorFunc = <T>(response: SchemaAgentResponse<any>) => PaginationInfo<T>;

/**
 * Function that can create a dictionary of identity values.
 */
export type PaginationRequestGeneratorFunc = <T>(page: number, limit: number) => IdentityValues;

/**
 * Generic method for fetching pagination information from an agent response.
 */
function genericPaginationInfoExtractor<T>(response: SchemaAgentResponse<any>): PaginationInfo<T> {

}

/**
 * Generic method for generating urlData for an agent request.
 */
function genericPaginationRequestGenerator<T>(page: number, limit: number): IdentityValues {
    let urlData: IdentityValues = { };

    // Set the possible variations of the page keyword.
    for (let key of paginationPageProperties) {
        urlData[key] = page;
        urlData[_.snakeCase(key)] = page;
        urlData[_.kebabCase(key)] = page;
    }

    // Set the possible variations of the limit keyword.
    for (let key of paginationPageLimitProperties) {
        urlData[key] = limit;
        urlData[_.snakeCase(key)] = limit;
        urlData[_.kebabCase(key)] = limit;
    }

    return urlData;
}

/**
 * Properties that commonly identify the amount of items that should be displayed per page.
 */
const paginationPageLimitProperties = [
    'limit',
    'perPage'
];

/**
 * Properties that commonly identify the currently loaded page.
 */
const paginationPageProperties = [
    'index',
    'page',
    'pageNumber'
];

/**
 * Properties that commonly identify an property or header that contains the total number of items in the collection.
 */
const paginationPageCountProperties = [
    'pages',
    'numPages',
    'length',
    'size'
];

/**
 * Properties that commonly identify an property or header that contains the total number of items in the collection.
 */
const paginationCollectionCountProperties = [
    'totalCount',
    'itemCount'
];