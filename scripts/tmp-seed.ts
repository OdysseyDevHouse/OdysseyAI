import { getOnlineSettings, saveOnlineSettings, listDepartmentVisibility, setDepartmentVisibility } from '../src/lib/site/onlineStore'
import { saveDraft, publishDraft, saveTheme } from '../src/lib/site/storefrontLayout'
import { createPublicStoreToken } from '../src/lib/publicStoreToken'
import { siteExecute } from '../src/lib/siteDb'
async function main(){
  const s=await getOnlineSettings(1); const {updatedAt:_a,updatedBy:_b,...base}=s
  for (const d of (await listDepartmentVisibility(1)).slice(0,4)) await setDepartmentVisibility(1,d.id,true)
  await saveOnlineSettings(1,{...base,isEnabled:true,publishMode:'departments',collectEnabled:true,
    deliverEnabled:false,minOrderIncl:0,reviewsEnabled:true,showStock:true,showPhotos:true,showBrands:true,
    blurb:'Fresh every morning'},'seed')
  await saveTheme(1,{heroHeadline:'Order online, collect in store',heroSubtext:'Everything we sell, ready when you are.'})
  await saveDraft(1,[
    {id:'hero',kind:'hero',title:'',enabled:true},
    {id:'cats',kind:'categories',title:'Shop by department',enabled:true,maxItems:0},
    {id:'newest',kind:'products',title:'New in',enabled:true,source:'newest',maxItems:10},
  ])
  await publishDraft(1)
  // A stock level low enough to show the "Only n left" badge.
  await siteExecute(1,`UPDATE products SET stock_on_hand=3 WHERE id=(SELECT id FROM (SELECT p.id FROM products p JOIN product_prices pp ON pp.product_id=p.id WHERE p.is_archived=0 AND pp.selling_price_incl>0 ORDER BY p.id DESC LIMIT 1) t)`)
  console.log('token:', await createPublicStoreToken(1))
  process.exit(0)
}
main().catch(e=>{console.error(e);process.exit(1)})
