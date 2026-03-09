import { DataSourcePlugin } from '@grafana/data';
import { DataSource } from './datasource';
import { ConfigEditor } from './ConfigEditor';
import { QueryEditor } from './QueryEditor';
import { AacynQuery, AacynDataSourceOptions } from './types';

export const plugin = new DataSourcePlugin<DataSource, AacynQuery, AacynDataSourceOptions>(DataSource)
    .setConfigEditor(ConfigEditor)
    .setQueryEditor(QueryEditor);
