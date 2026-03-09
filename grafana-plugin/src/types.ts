import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

/**
 * Query model — matches the Go backend's queryModel struct.
 */
export interface AacynQuery extends DataQuery {
    queryText: string;
}

/**
 * Datasource configuration — matches the Go backend's DatasourceSettings.
 */
export interface AacynDataSourceOptions extends DataSourceJsonData {
    url?: string;
}

export const DEFAULT_QUERY: Partial<AacynQuery> = {
    queryText: 'SELECT timestamp, duration, is_error FROM events',
};
