import {Err} from 'ts-results-es';
import {ApiErr} from '@proxy/utils';
import {findIntegration, type IntegrationId} from '@proxy/integrations';

import type {Connector} from './connector';
import {emailConnector} from './email-connector';
import {granolaConnector} from './granola-connector';
import {infoConnector} from './info-connector';
import {linearConnector} from './linear-connector';
import {notionConnector} from './notion-connector';

// Custom MCP tools have no record collections; never adapt them into record writes.
const noRecords = async () => Err(ApiErr.notFound('collection'));
const customConnector: Connector = {list: noRecords, get: noRecords, create: noRecords, update: noRecords, remove: noRecords};

const CONNECTORS: Record<IntegrationId, Connector> = {
	info: infoConnector,
	'custom-mcp': customConnector,
	email: emailConnector,
	granola: granolaConnector,
	notion: notionConnector,
	linear: linearConnector,
};

export function connectorFor(integrationId: string): Connector | undefined {
	const integration = findIntegration(integrationId);
	return integration && CONNECTORS[integration.id];
}
