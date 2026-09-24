import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
} from 'n8n-workflow';

import { hesperanRequest } from './transport';

/** A decision profile as `GET /v1/profiles` lists it (free, not metered). */
export interface Profile {
	slug: string;
	name?: string;
	type?: 'choice' | 'noul' | 'score';
	options?: string[];
	calibrated?: boolean;
	calibration_status?: string;
	calibration_version?: number;
	target_precision?: number;
}

async function listProfiles(this: ILoadOptionsFunctions): Promise<Profile[]> {
	const response = await hesperanRequest.call(this, {
		endpoint: 'profiles',
		method: 'GET',
		path: '/v1/profiles',
		retry: true,
		itemIndex: 0,
	});
	const profiles = (response.body as IDataObject).profiles;
	return Array.isArray(profiles) ? (profiles as Profile[]).filter((p) => typeof p?.slug === 'string') : [];
}

/** Resource locator list: the account's profiles, searchable by name or slug. */
export async function searchProfiles(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const needle = (filter ?? '').trim().toLowerCase();
	const profiles = await listProfiles.call(this);
	return {
		results: profiles
			.filter((p) => !needle || p.slug.toLowerCase().includes(needle) || (p.name ?? '').toLowerCase().includes(needle))
			.map((p) => ({
				name: `${p.name && p.name !== p.slug ? `${p.name} (${p.slug})` : p.slug}${p.calibrated === false ? ' – not calibrated yet' : ''}`,
				value: p.slug,
			})),
	};
}

/** The answers a profile accepts as the actual outcome, for "Report Outcome". */
export async function getProfileAnswers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const slug = String(this.getCurrentNodeParameter('profile', { extractValue: true }) ?? '').trim();
	if (!slug) return [];
	const profile = (await listProfiles.call(this)).find((p) => p.slug === slug);
	if (!profile) return [];
	return (profile.options ?? []).map((option) => ({
		name: profile.type === 'noul' ? (option === 'true' ? 'Yes (true)' : option === 'false' ? 'No (false)' : option) : option,
		value: option,
	}));
}
