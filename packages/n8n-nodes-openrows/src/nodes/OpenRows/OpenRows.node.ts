import {
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';
import { recordProperties } from './description';
import { listSearch, loadOptions, resourceMapping } from './methods';
import { OPERATIONS } from './records';
import { CREDENTIALS } from './transport';

/** Records of an OpenRows table through the REST API v1, with a personal access token. */
export class OpenRows implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'OpenRows',
    name: 'openRows',
    icon: 'file:openrows.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Read and write records in OpenRows, the open-source Airtable alternative',
    defaults: { name: 'OpenRows' },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIALS, required: true }],
    properties: recordProperties,
  };

  methods = { listSearch, loadOptions, resourceMapping };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const operation = this.getNodeParameter('operation', 0) as string;
    const run = OPERATIONS[operation];
    if (!run) {
      throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`);
    }
    return [await run(this, items)];
  }
}
