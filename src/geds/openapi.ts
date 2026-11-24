/**
 * The OpenAPI document for the GEDS surfaces.
 *
 * It is generated from this file rather than checked in twice: the route
 * handlers and the reference have to describe the same parameters, and the
 * examples are written in both languages because the directory is bilingual
 * all the way through — the same unit resolves from `Corporate Management
 * Branch` and `Direction générale de la gestion intégrée`.
 */

export const GEDS_OPENAPI_PATH = '/api/geds/openapi.json';

const error = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      examples: {
        en: { value: { error: 'q is too long', code: 'INVALID_ARGUMENT', correlationId: 'req_…' } },
        fr: { value: { error: 'q est trop long', code: 'INVALID_ARGUMENT', correlationId: 'req_…' } },
      },
    },
  },
});

const pageParameters = [
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    description: 'Maximum results. Bounded so a search cannot become a download.',
  },
  {
    name: 'offset',
    in: 'query',
    schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
    description: 'Result offset. The response reports `total` and `hasMore`.',
  },
];

const commonParameters = [
  {
    name: 'lang',
    in: 'query',
    schema: { type: 'string', enum: ['en', 'fr'], default: 'en' },
    description:
      "The language of the result's selected labels and names. Search always matches both languages; this only chooses which one is primary.",
    examples: { en: { value: 'en' }, fr: { value: 'fr' } },
  },
  {
    name: 'asOf',
    in: 'query',
    schema: { type: 'string', format: 'date' },
    description:
      'Read the directory as it was observed on or before this date, or at this ISO 8601 timestamp. A date means the end of that UTC day.',
    examples: {
      en: { value: '2026-10-25' },
      fr: { value: '2026-10-25T14:00:00Z' },
    },
  },
  ...pageParameters,
];

const contactSchema = {
  type: 'object',
  required: ['kind', 'field', 'label', 'value', 'isGeneralOffice', 'citation'],
  properties: {
    kind: {
      type: 'string',
      enum: [
        'telephone',
        'fax',
        'tdd',
        'secureTelephone',
        'secureFax',
        'alternateTelephone',
        'administrativeAssistant',
        'executiveAssistant',
        'email',
        'postal',
      ],
    },
    field: { type: 'string', example: 'Telephone Number' },
    label: { type: 'string', example: 'Telephone Number' },
    publisherLabel: { type: 'string', example: 'Telephone Number' },
    value: { type: 'string', example: '613-555-0142' },
    isGeneralOffice: { type: 'boolean' },
    parts: { type: 'object', additionalProperties: { type: 'string' } },
    citation: { $ref: '#/components/schemas/Citation' },
  },
};

const citationSchema = {
  type: 'object',
  required: ['datasetId', 'datasetUrl', 'resourceUrl', 'observedAt', 'snapshotId', 'entity', 'text'],
  properties: {
    datasetId: { type: 'string', example: '8ec4a9df-b76b-4a67-8f93-cdbc2e040098' },
    datasetUrl: {
      type: 'string',
      format: 'uri',
      example: 'https://open.canada.ca/data/dataset/8ec4a9df-b76b-4a67-8f93-cdbc2e040098',
    },
    resourceUrl: {
      type: 'string',
      format: 'uri',
      example: 'https://api.geds-sage.gc.ca/GEDS20/dist/opendata/gedsOpenData.zip',
    },
    sourceDate: { type: 'string', format: 'date-time', nullable: true },
    observedAt: { type: 'string', format: 'date-time' },
    asOf: { type: 'string', format: 'date-time' },
    snapshotId: { type: 'string', example: 'snap_…' },
    entity: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['person', 'organization', 'role'] },
        id: { type: 'string' },
      },
    },
    field: { type: 'string' },
    roleId: { type: 'string' },
    personId: { type: 'string' },
    text: {
      type: 'string',
      example:
        'GEDS — Example Department — Corporate Management Branch — Alex Tremblay — Assistant Deputy Minister — Telephone Number: 613-555-0142 (observed 2026-10-25T14:00:00Z)',
    },
  },
};

const organizationSchema = {
  type: 'object',
  required: ['id', 'name', 'nameEn', 'nameFr', 'department', 'level', 'path'],
  properties: {
    id: { type: 'string', example: 'org_…' },
    name: { type: 'string' },
    nameEn: { type: 'string' },
    nameFr: { type: 'string' },
    acronym: { type: 'string', nullable: true },
    department: {
      type: 'object',
      properties: {
        acronym: { type: 'string' },
        name: { type: 'string', nullable: true },
        nameEn: { type: 'string', nullable: true },
        nameFr: { type: 'string', nullable: true },
      },
    },
    parent: { type: 'object', nullable: true },
    level: { type: 'integer' },
    path: { type: 'string' },
  },
};

const snapshotSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    seq: { type: 'integer' },
    effectiveAt: { type: 'string', format: 'date-time' },
    publishedAt: { type: 'string', format: 'date-time', nullable: true },
    sourceDate: { type: 'string', format: 'date-time', nullable: true },
    sourceUrl: { type: 'string', format: 'uri' },
    datasetId: { type: 'string' },
    datasetUrl: { type: 'string', format: 'uri' },
    original: {
      type: 'object',
      properties: {
        sha256: { type: 'string' },
        csvSha256: { type: 'string' },
        archiveKey: { type: 'string', nullable: true },
      },
    },
  },
};

const GEDS_OPENAPI_TEMPLATE = {
    openapi: '3.1.0',
    info: {
      title: 'CivicSignal — GEDS directory',
      version: '0.1.0',
      description:
        'A bilingual directory of Government of Canada units, people and published professional contacts, with historical reads. ' +
        'Every result is cited to the official GEDS export and to the snapshot in which it was observed.',
      contact: { name: 'CivicSignal', url: 'https://api.civicsignal.ca' },
      license: { name: 'Open Government Licence - Canada', url: 'https://open.canada.ca/en/open-government-licence-canada' },
    },
    servers: [{ url: 'https://api.civicsignal.ca' }],
    security: [{ serverKey: [] }],
    tags: [
      { name: 'Organizations', description: 'Units, hierarchy and the people published in them.' },
      { name: 'People', description: 'People, their roles and cited contacts.' },
    ],
    paths: {
      '/api/organizations': {
        get: {
          tags: ['Organizations'],
          summary: 'Search organizations in either official language',
          description:
            'Searches the published English and French names, acronyms, department names and the DN chain. ' +
            'The same unit resolves from either name to one id.',
          parameters: [
            {
              name: 'q',
              in: 'query',
              schema: { type: 'string' },
              description: 'A name, acronym or fragment in English or French.',
              examples: {
                en: { value: 'Corporate Management Branch' },
                fr: { value: 'Direction générale de la gestion intégrée' },
              },
            },
            {
              name: 'exact',
              in: 'query',
              schema: { type: 'boolean', default: false },
              description: 'Match the whole published name (in either language) rather than a fragment.',
            },
            ...commonParameters,
          ],
          responses: {
            '200': {
              description: 'Matching units, in the selected language and at the selected snapshot.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string' },
                      language: { type: 'string', enum: ['en', 'fr'] },
                      asOf: { type: 'string', format: 'date-time' },
                      snapshot: { $ref: '#/components/schemas/Snapshot' },
                      items: { type: 'array', items: { $ref: '#/components/schemas/Organization' } },
                      page: { $ref: '#/components/schemas/Page' },
                    },
                  },
                  examples: {
                    en: {
                      summary: 'English name',
                      value: {
                        query: 'Corporate Management Branch',
                        language: 'en',
                        asOf: '2026-10-25T14:00:00.000Z',
                        items: [
                          {
                            id: 'org_example',
                            name: 'Corporate Management Branch',
                            nameEn: 'Corporate Management Branch',
                            nameFr: 'Direction générale de la gestion intégrée',
                            acronym: null,
                            department: {
                              acronym: 'AAFC-AAC',
                              name: 'Agriculture and Agri-Food Canada',
                              nameEn: 'Agriculture and Agri-Food Canada',
                              nameFr: 'Agriculture et agroalimentaire Canada',
                            },
                            level: 2,
                            path: 'root/ou:aafc-aac/ou:cmb-dggi',
                          },
                        ],
                        page: { limit: 20, offset: 0, total: 1, hasMore: false },
                      },
                    },
                    fr: {
                      summary: 'French name',
                      value: {
                        query: 'Direction générale de la gestion intégrée',
                        language: 'fr',
                        asOf: '2026-10-25T14:00:00.000Z',
                        items: [
                          {
                            id: 'org_example',
                            name: 'Direction générale de la gestion intégrée',
                            nameEn: 'Corporate Management Branch',
                            nameFr: 'Direction générale de la gestion intégrée',
                            acronym: null,
                            department: {
                              acronym: 'AAFC-AAC',
                              name: 'Agriculture et agroalimentaire Canada',
                              nameEn: 'Agriculture and Agri-Food Canada',
                              nameFr: 'Agriculture et agroalimentaire Canada',
                            },
                            level: 2,
                            path: 'root/ou:aafc-aac/ou:cmb-dggi',
                          },
                        ],
                        page: { limit: 20, offset: 0, total: 1, hasMore: false },
                      },
                    },
                  },
                },
              },
            },
            '400': error('A parameter is invalid.'),
            '401': error('A Server API key is required.'),
            '404': error('No published snapshot exists for the requested asOf.'),
          },
        },
      },
      '/api/organizations/{id}': {
        get: {
          tags: ['Organizations'],
          summary: 'Exact organization lookup with hierarchy',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ...commonParameters.slice(0, 1),
            ...commonParameters.slice(1, 2),
          ],
          responses: {
            '200': {
              description: 'The unit, its ancestors, its immediate children, and any general-office contact.',
              content: {
                'application/json': {
                  examples: {
                    en: {
                      value: {
                        organization: {
                          id: 'org_example',
                          name: 'Corporate Management Branch',
                          nameEn: 'Corporate Management Branch',
                          nameFr: 'Direction générale de la gestion intégrée',
                        },
                        ancestors: [{ id: 'org_department', name: 'Agriculture and Agri-Food Canada' }],
                        children: [],
                        peopleCount: 2,
                        officeContact: null,
                      },
                    },
                    fr: {
                      value: {
                        organization: {
                          id: 'org_example',
                          name: 'Direction générale de la gestion intégrée',
                          nameEn: 'Corporate Management Branch',
                          nameFr: 'Direction générale de la gestion intégrée',
                        },
                        ancestors: [{ id: 'org_department', name: 'Agriculture et agroalimentaire Canada' }],
                        children: [],
                        peopleCount: 2,
                        officeContact: null,
                      },
                    },
                  },
                },
              },
            },
            '404': error('The unit does not exist at this snapshot.'),
          },
        },
      },
      '/api/organizations/{id}/hierarchy': {
        get: {
          tags: ['Organizations'],
          summary: 'The organizational hierarchy around a unit',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ...commonParameters.slice(0, 2),
          ],
          responses: { '200': { description: 'Ancestors and immediate children.' }, '404': error('Not found.') },
        },
      },
      '/api/organizations/{id}/people': {
        get: {
          tags: ['Organizations'],
          summary: 'The people published in a unit',
          description:
            'Returns one entry per person, with every role that person holds in the unit. A unit with no people but a general office number returns `officeContact` instead of an empty list with no explanation.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'descendants',
              in: 'query',
              schema: { type: 'boolean', default: false },
              description: 'Include people in child units.',
            },
            ...commonParameters,
          ],
          responses: {
            '200': {
              description: 'People and their roles.',
              content: {
                'application/json': {
                  examples: {
                    en: {
                      value: {
                        organization: { id: 'org_office', name: 'General Office' },
                        items: [],
                        officeContact: {
                          reachedVia: 'general-office',
                          contact: {
                            label: 'General office — Telephone Number',
                            value: '613-555-0100',
                            isGeneralOffice: true,
                            citation: {
                              text: 'GEDS — Example Department — General Office — General Enquiries — General office — Telephone Number: 613-555-0100',
                            },
                          },
                        },
                        page: { limit: 20, offset: 0, total: 0, hasMore: false },
                      },
                    },
                    fr: {
                      value: {
                        organization: { id: 'org_office', name: 'Bureau principal' },
                        items: [],
                        officeContact: {
                          reachedVia: 'general-office',
                          contact: {
                            label: 'Bureau principal — Numéro de téléphone',
                            value: '613-555-0100',
                            isGeneralOffice: true,
                          },
                        },
                        page: { limit: 20, offset: 0, total: 0, hasMore: false },
                      },
                    },
                  },
                },
              },
            },
            '404': error('Not found.'),
          },
        },
      },
      '/api/people': {
        get: {
          tags: ['People'],
          summary: 'Search people in either official language',
          parameters: [
            {
              name: 'q',
              in: 'query',
              schema: { type: 'string' },
              description: 'A name, title or email fragment. English and French titles are both searched.',
              examples: { en: { value: 'Alex Tremblay' }, fr: { value: 'Sous-ministre adjoint' } },
            },
            {
              name: 'exact',
              in: 'query',
              schema: { type: 'boolean', default: false },
              description: 'Match the whole folded name, or the whole email address.',
            },
            {
              name: 'organizationId',
              in: 'query',
              schema: { type: 'string' },
              description: 'Restrict to one unit (not its descendants).',
            },
            ...commonParameters,
          ],
          responses: {
            '200': {
              description: 'People matching the query.',
              content: {
                'application/json': {
                  examples: {
                    en: {
                      value: {
                        query: 'Alex Tremblay',
                        language: 'en',
                        items: [
                          {
                            id: 'per_example',
                            name: 'Alex Tremblay',
                            givenName: 'Alex',
                            surname: 'Tremblay',
                            title: { en: 'Assistant Deputy Minister', fr: 'Sous-ministre adjoint' },
                            organization: { id: 'org_example', name: 'Corporate Management Branch' },
                            contact: {
                              label: 'Telephone Number',
                              value: '613-555-0142',
                              citation: {
                                text: 'GEDS — Example Department — Corporate Management Branch — Alex Tremblay — Assistant Deputy Minister — Telephone Number: 613-555-0142',
                              },
                            },
                          },
                        ],
                        page: { limit: 20, offset: 0, total: 1, hasMore: false },
                      },
                    },
                    fr: {
                      value: {
                        query: 'Sous-ministre adjoint',
                        language: 'fr',
                        items: [
                          {
                            id: 'per_example',
                            name: 'Alex Tremblay',
                            title: { en: 'Assistant Deputy Minister', fr: 'Sous-ministre adjoint' },
                            organization: { id: 'org_example', name: 'Direction générale de la gestion intégrée' },
                            contact: { label: 'Numéro de téléphone', value: '613-555-0142' },
                          },
                        ],
                        page: { limit: 20, offset: 0, total: 1, hasMore: false },
                      },
                    },
                  },
                },
              },
            },
            '400': error('A parameter is invalid.'),
          },
        },
      },
      '/api/people/{id}': {
        get: {
          tags: ['People'],
          summary: 'Exact person lookup with every published role',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            ...commonParameters.slice(0, 2),
          ],
          responses: {
            '200': {
              description: 'The person and the roles they held at the selected snapshot.',
              content: {
                'application/json': {
                  examples: {
                    en: {
                      value: {
                        id: 'per_example',
                        name: 'Alex Tremblay',
                        roles: [
                          {
                            id: 'role_example',
                            title: { en: 'Assistant Deputy Minister', fr: 'Sous-ministre adjoint' },
                            organization: { id: 'org_example', name: 'Corporate Management Branch' },
                            contact: { label: 'Telephone Number', value: '613-555-0142' },
                          },
                        ],
                      },
                    },
                    fr: {
                      value: {
                        id: 'per_example',
                        name: 'Alex Tremblay',
                        roles: [
                          {
                            id: 'role_example',
                            title: { en: 'Assistant Deputy Minister', fr: 'Sous-ministre adjoint' },
                            organization: { id: 'org_example', name: 'Direction générale de la gestion intégrée' },
                            contact: { label: 'Numéro de téléphone', value: '613-555-0142' },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            '404': error('The person is not published at this snapshot.'),
          },
        },
      },
      '/api/people/{id}/contact': {
        get: {
          tags: ['People'],
          summary: 'One cited professional contact as it appeared on a selected date',
          description:
            'Selects a contact from the person\'s role at the requested unit, and falls back to the unit\'s general office with `reachedVia: "general-office"` rather than presenting a switchboard as a direct line.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'organizationId', in: 'query', schema: { type: 'string' } },
            { name: 'roleId', in: 'query', schema: { type: 'string' } },
            ...commonParameters.slice(0, 2),
          ],
          responses: {
            '200': {
              description: 'The contact and its citation.',
              content: {
                'application/json': {
                  examples: {
                    en: {
                      value: {
                        person: { id: 'per_example', name: 'Alex Tremblay' },
                        contact: {
                          label: 'Telephone Number',
                          value: '613-555-0142',
                          isGeneralOffice: false,
                          citation: {
                            datasetId: '8ec4a9df-b76b-4a67-8f93-cdbc2e040098',
                            resourceUrl: 'https://api.geds-sage.gc.ca/GEDS20/dist/opendata/gedsOpenData.zip',
                            observedAt: '2026-10-25T14:00:00.000Z',
                            snapshotId: 'snap_example',
                            text: 'GEDS — Example Department — Corporate Management Branch — Alex Tremblay — Assistant Deputy Minister — Telephone Number: 613-555-0142',
                          },
                        },
                        reachedVia: 'direct',
                        asOf: '2026-10-25',
                      },
                    },
                    fr: {
                      value: {
                        person: { id: 'per_example', name: 'Alex Tremblay' },
                        contact: {
                          label: 'Numéro de téléphone',
                          value: '613-555-0142',
                          isGeneralOffice: false,
                        },
                        reachedVia: 'direct',
                        asOf: '2026-10-25',
                      },
                    },
                  },
                },
              },
            },
            '404': error('The person is not published at this snapshot.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        serverKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Server API key: `Authorization: Bearer sk_…`. Errors are never billable.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'code', 'correlationId'],
          properties: {
            error: { type: 'string' },
            code: { type: 'string' },
            correlationId: { type: 'string' },
            timestamp: { type: 'integer' },
          },
        },
        Page: {
          type: 'object',
          properties: {
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            total: { type: 'integer' },
            hasMore: { type: 'boolean' },
          },
        },
        Citation: citationSchema,
        Contact: contactSchema,
        Organization: organizationSchema,
        Snapshot: snapshotSchema,
      },
    },
};

export function buildGedsOpenApi(baseUrl = 'https://api.civicsignal.ca', product = 'CivicSignal') {
  return {
    ...GEDS_OPENAPI_TEMPLATE,
    info: {
      ...GEDS_OPENAPI_TEMPLATE.info,
      title: `${product} — GEDS directory`,
      contact: { name: product, url: baseUrl },
    },
    servers: [{ url: baseUrl }],
  };
}
