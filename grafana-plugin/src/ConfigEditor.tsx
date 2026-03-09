import React from 'react';
import { InlineField, Input } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { AacynDataSourceOptions } from './types';

type Props = DataSourcePluginOptionsEditorProps<AacynDataSourceOptions>;

/**
 * ConfigEditor — Minimal configuration for the aacyn data source.
 * Single field: the aacyn API URL (defaults to http://localhost:3001).
 */
export function ConfigEditor(props: Props) {
    const { onOptionsChange, options } = props;
    const jsonData = options.jsonData;

    const onURLChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        onOptionsChange({
            ...options,
            jsonData: {
                ...jsonData,
                url: event.target.value,
            },
        });
    };

    return (
        <div className="gf-form-group">
            <InlineField label="aacyn API URL" labelWidth={20} tooltip="HTTP endpoint of the aacyn engine">
                <Input
                    id="aacyn-url"
                    value={jsonData.url || 'http://localhost:3001'}
                    onChange={onURLChange}
                    placeholder="http://localhost:3001"
                    width={40}
                />
            </InlineField>
        </div>
    );
}
