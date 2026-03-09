import React from 'react';
import { CodeEditor } from '@grafana/ui';
import { QueryEditorProps } from '@grafana/data';
import { DataSource } from './datasource';
import { AacynQuery, AacynDataSourceOptions, DEFAULT_QUERY } from './types';

type Props = QueryEditorProps<DataSource, AacynQuery, AacynDataSourceOptions>;

/**
 * QueryEditor — Raw SQL-like query input for engineers.
 * Uses Grafana's CodeEditor with SQL syntax highlighting.
 */
export function QueryEditor({ query, onChange, onRunQuery }: Props) {
    const queryText = query.queryText ?? DEFAULT_QUERY.queryText ?? '';

    const onQueryTextChange = (value: string) => {
        onChange({ ...query, queryText: value });
    };

    const onBlur = () => {
        onRunQuery();
    };

    return (
        <div style={{ width: '100%' }}>
            <CodeEditor
                value={queryText}
                language="sql"
                height="120px"
                showMiniMap={false}
                showLineNumbers={true}
                onBlur={onBlur}
                onSave={onBlur}
                onChange={onQueryTextChange}
                monacoOptions={{
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 14,
                    wordWrap: 'on',
                }}
            />
        </div>
    );
}
