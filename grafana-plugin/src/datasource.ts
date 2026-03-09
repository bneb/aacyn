import {
    DataSourceInstanceSettings,
    CoreApp,
    ScopedVars,
} from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';
import { AacynQuery, AacynDataSourceOptions, DEFAULT_QUERY } from './types';

export class DataSource extends DataSourceWithBackend<AacynQuery, AacynDataSourceOptions> {
    constructor(instanceSettings: DataSourceInstanceSettings<AacynDataSourceOptions>) {
        super(instanceSettings);
    }

    getDefaultQuery(_: CoreApp): Partial<AacynQuery> {
        return DEFAULT_QUERY;
    }

    applyTemplateVariables(query: AacynQuery, scopedVars: ScopedVars): AacynQuery {
        return {
            ...query,
            queryText: getTemplateSrv().replace(query.queryText, scopedVars),
        };
    }
}
