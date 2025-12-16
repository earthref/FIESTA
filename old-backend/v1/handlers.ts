import root from './path/root';
import publicDownload from './path/public.download';
import publicData from './path/public.data';
import publicSearch from './path/public.search';
import publicValidate from './path/public.validate';
import privateCreateUpdateDelete from './path/private';
import privateDownload from './path/private.download';
import privateSearch from './path/private.search';
import privateData from './path/private.data';
import privateValidate from './path/private.validate';

export default {
	...root,
	...publicDownload,
	...publicData,
	...publicSearch,
	...publicValidate,
	...privateCreateUpdateDelete,
	...privateDownload,
	...privateSearch,
	...privateData,
	...privateValidate,
};
